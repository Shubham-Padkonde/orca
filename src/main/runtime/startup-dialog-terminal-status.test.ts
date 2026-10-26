import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  observeTrustDialogScreenChange,
  trustDialogSettledStatus,
  trustDialogWaitingStatus
} from './startup-dialog-terminal-status'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  type TranscriptPaneOptions
} from './agent-transcript-pane-test-harness'

function fixture(name: string): { recording: string; cols: number; rows: number } {
  const url = (ext: string) => new URL(`./__fixtures__/${name}.${ext}`, import.meta.url)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(url('meta.json'), 'utf8'))
  return { recording: readFileSync(url('txt'), 'utf8'), cols: meta.cols, rows: meta.rows }
}

async function replay(emulator: HeadlessEmulator, recording: string, size: number) {
  const changes: boolean[] = []
  for (let index = 0; index < recording.length; index += size) {
    const chunk = recording.slice(index, index + size)
    await emulator.write(chunk)
    const change = observeTrustDialogScreenChange(emulator, chunk)
    if (change !== null) {
      changes.push(change)
    }
  }
  return changes
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
    ['claude-dialog-trust-workspace', 1, [true]],
    ['claude-dialog-trust-workspace', 8192, [true]],
    ['claude-dialog-trust-workspace-narrow', 1, [true]],
    ['claude-dialog-trust-workspace-answered', 1, [true, false]],
    ['claude-dialog-trust-workspace-answered', 64, [true, false]],
    ['codex-0-158-0-trustprompt', 1, [true]],
    ['codex-0-158-0-trustprompt', 8192, [true]],
    ['codex-0-164-0-trustprompt-answered', 1, [true, false]],
    ['codex-0-164-0-trustprompt-answered', 64, [true, false]]
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
        '• Codex shows "Do you trust this folder?" with 1. Trust and continue\r\n' +
        '  and Claude shows "Yes, I trust this folder".\r\n\r\n' +
        '› Ask Codex to do anything\r\n  gpt-5 · ~/repo\r\n'
      expect(await replay(emulator, reply, 8192)).toEqual([])
    } finally {
      emulator.dispose()
    }
  })

  it('clears when the exiting agent erases its dialog under the shell prompt', async () => {
    const { recording, cols, rows } = fixture('claude-dialog-trust-workspace')
    const emulator = new HeadlessEmulator({ cols, rows })
    try {
      expect(await replay(emulator, recording, 8192)).toEqual([true])
      expect(await replay(emulator, '\x1b[J\r\nuser@host repo $ ', 8192)).toEqual([false])
      // Cleared panes stop reading the screen until the keyword is painted again.
      expect(await replay(emulator, 'ls\r\n', 8192)).toEqual([])
    } finally {
      emulator.dispose()
    }
  })

  it('settles the row when a killed agent leaves its dialog frame above the shell prompt', async () => {
    const rows = new Map<string, AgentStatusIpcPayload>()
    const pane: TranscriptPaneOptions = {
      paneTitle: 'Terminal',
      foregroundProcess: '2.1.310',
      launchAgent: 'claude',
      size: { cols: 120, rows: 40 },
      data: ''
    }
    const { runtime } = await createTranscriptPane(pane, {
      onTerminalAgentStatus: ({ paneKey, payload }) => {
        rows.set(paneKey, row({ ...payload, paneKey }))
      },
      getAgentStatusSnapshotForPane: (paneKey) => {
        const current = rows.get(paneKey)
        return current ? [current] : []
      }
    })
    const states = () => [...rows.values()].map((current) => current.state)
    try {
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        fixture('claude-dialog-trust-workspace').recording,
        1
      )
      await vi.waitFor(() => expect(states()).toEqual(['waiting']))
      // The shell prompt lands inside the stale frame, so only the foreground proves the exit.
      pane.foregroundProcess = 'zsh'
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'user@host repo $ ', 2)
      await vi.waitFor(() => expect(states()).toEqual(['done']))
    } finally {
      await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
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
