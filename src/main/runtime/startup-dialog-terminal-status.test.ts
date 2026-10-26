import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  confirmTrustDialogGone,
  observeTrustDialogScreenChange,
  type TrustDialogScreenRead,
  trustDialogSettledStatus,
  trustDialogWaitingStatus
} from './startup-dialog-terminal-status'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  type TranscriptPaneOptions
} from './agent-transcript-pane-test-harness'
import { TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'

function fixture(name: string): { recording: string; cols: number; rows: number } {
  const url = (ext: string) => new URL(`./__fixtures__/${name}.${ext}`, import.meta.url)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(url('meta.json'), 'utf8'))
  return { recording: readFileSync(url('txt'), 'utf8'), cols: meta.cols, rows: meta.rows }
}

/** Distinct consecutive screen reads, so per-chunk repeats collapse. */
async function replay(emulator: HeadlessEmulator, recording: string, size: number) {
  const reads: NonNullable<TrustDialogScreenRead>[] = []
  for (let index = 0; index < recording.length; index += size) {
    const chunk = recording.slice(index, index + size)
    await emulator.write(chunk)
    const read = observeTrustDialogScreenChange(emulator, chunk)
    if (read !== null && read !== reads.at(-1)) {
      reads.push(read)
    }
  }
  return reads
}

async function createTrustDialogPane() {
  const rows = new Map<string, AgentStatusIpcPayload>()
  const published: string[] = []
  const pane: TranscriptPaneOptions = {
    paneTitle: 'Terminal',
    foregroundProcess: '2.1.310',
    launchAgent: 'claude',
    size: { cols: 120, rows: 40 },
    data: ''
  }
  const { runtime } = await createTranscriptPane(pane, {
    onTerminalAgentStatus: ({ paneKey, payload }) => {
      published.push(payload.state)
      rows.set(paneKey, row({ ...payload, paneKey }))
    },
    getAgentStatusSnapshotForPane: (paneKey) => {
      const current = rows.get(paneKey)
      return current ? [current] : []
    }
  })
  return { runtime, published }
}

function row(fields: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'done',
    prompt: '',
    paneKey: 'tab:leaf',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    ...fields
  }
}

describe('startup trust dialog terminal status', () => {
  // One byte at a time splits the keyword; Claude's Ink paints words apart with cursor moves.
  it.each([
    ['claude-dialog-trust-workspace', 1, ['appeared']],
    ['claude-dialog-trust-workspace', 8192, ['appeared']],
    ['claude-dialog-trust-workspace-narrow', 1, ['appeared']],
    ['claude-dialog-trust-workspace-answered', 64, ['appeared', 'present', 'absent']],
    ['codex-0-158-0-trustprompt', 1, ['appeared']],
    ['codex-0-158-0-trustprompt', 8192, ['appeared']],
    ['codex-0-164-0-trustprompt-answered', 64, ['appeared', 'present', 'absent']]
  ] as const)('replays %s in %i-byte chunks', async (name, size, expected) => {
    const { recording, cols, rows } = fixture(name)
    const emulator = new HeadlessEmulator({ cols, rows })
    try {
      expect(await replay(emulator, recording, size)).toEqual(expected)
    } finally {
      emulator.dispose()
    }
  })

  it('ignores the dialog wording quoted in ordinary output', async () => {
    const emulator = new HeadlessEmulator({ cols: 100, rows: 24 })
    try {
      const reply =
        '\u2022 Codex shows "Do you trust this folder?" with 1. Trust and continue\r\n' +
        '  and Claude shows "Yes, I trust this folder".\r\n\r\n' +
        '\u203a Ask Codex to do anything\r\n  gpt-5 \u00b7 ~/repo\r\n'
      expect(await replay(emulator, reply, 8192)).toEqual([])
    } finally {
      emulator.dispose()
    }
  })

  it('needs a settled screen without the dialog before forgetting it', async () => {
    const { recording, cols, rows } = fixture('claude-dialog-trust-workspace')
    const emulator = new HeadlessEmulator({ cols, rows })
    try {
      expect(await replay(emulator, recording, 8192)).toEqual(['appeared'])
      // A resize repaint split across reads: the clear lands before the redrawn dialog.
      expect(await replay(emulator, '\x1b[2J\x1b[H', 8192)).toEqual(['absent'])
      expect(await replay(emulator, recording, 8192)).toEqual(['present'])
      expect(confirmTrustDialogGone(emulator)).toBe(false)
      expect(await replay(emulator, '\x1b[J\r\nuser@host repo $ ', 8192)).toEqual(['absent'])
      expect(confirmTrustDialogGone(emulator)).toBe(true)
      expect(await replay(emulator, 'ls\r\n', 8192)).toEqual([])
    } finally {
      emulator.dispose()
    }
  })

  // Past the settle check's TUI_IDLE_QUIESCENCE_MS quiet window.
  const quietMs = TUI_IDLE_QUIESCENCE_MS + 1_000

  it('keeps one waiting row through a resize repaint and settles after a quiet erase', async () => {
    vi.useFakeTimers()
    const { runtime, published } = await createTrustDialogPane()
    const dialog = fixture('claude-dialog-trust-workspace').recording
    try {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, dialog, 1)
      await vi.advanceTimersByTimeAsync(100)
      expect(published).toEqual(['waiting'])
      // A resize repaint split across reads: the clear lands before the redrawn dialog.
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[2J\x1b[H', 2)
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, dialog, 3)
      await vi.advanceTimersByTimeAsync(quietMs)
      expect(published).toEqual(['waiting'])
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[J\r\nuser@host repo $ ', 4)
      await vi.advanceTimersByTimeAsync(quietMs)
      expect(published).toEqual(['waiting', 'done'])
    } finally {
      await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      vi.useRealTimers()
    }
  })

  it("settles a killed agent's leftover frame only once the shell is proven foreground", async () => {
    vi.useFakeTimers()
    const { runtime, published } = await createTrustDialogPane()
    const foreground = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('unknown')
    try {
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        fixture('claude-dialog-trust-workspace').recording,
        1
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(published).toEqual(['waiting'])
      // The shell prompt lands inside the stale frame, so the screen still shows the dialog.
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'user@host repo $ ', 2)
      await vi.advanceTimersByTimeAsync(quietMs)
      expect(published).toEqual(['waiting'])
      foreground.mockResolvedValue('shell')
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ' ', 3)
      await vi.advanceTimersByTimeAsync(quietMs)
      expect(published).toEqual(['waiting', 'done'])
    } finally {
      await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      vi.useRealTimers()
    }
  })

  it('yields to a live hook row and settles only the row it wrote', () => {
    const waiting = trustDialogWaitingStatus('claude', undefined)
    expect(waiting).toMatchObject({ state: 'waiting', agentType: 'claude' })
    expect(trustDialogWaitingStatus('qoder', undefined)).toBeNull()
    expect(
      trustDialogWaitingStatus(
        'claude',
        row({
          state: 'working',
          observation: {
            origin: 'hook',
            authorityId: 'hooks',
            incarnation: 0,
            revision: 1,
            observedAt: 1
          }
        })
      )
    ).toBeNull()

    expect(trustDialogSettledStatus(row({ ...waiting, agentType: 'claude' }))).toEqual({
      state: 'done',
      agentType: 'claude',
      prompt: '',
      sessionBoundary: true
    })
    expect(trustDialogSettledStatus(row({ state: 'working', agentType: 'claude' }))).toBeNull()
  })
})
