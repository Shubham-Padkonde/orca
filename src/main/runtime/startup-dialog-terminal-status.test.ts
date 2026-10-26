import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  observeTrustDialogScreenChange,
  trustDialogSettledStatus,
  trustDialogWaitingStatus
} from './startup-dialog-terminal-status'

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
    ['codex-0-158-0-trustprompt', 8192, [true]]
  ] as const)('replays %s in %i-byte chunks', async (name, size, expected) => {
    const { recording, cols, rows } = fixture(name)
    const emulator = new HeadlessEmulator({ cols, rows })
    try {
      expect(await replay(emulator, recording, size)).toEqual(expected)
    } finally {
      emulator.dispose()
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
