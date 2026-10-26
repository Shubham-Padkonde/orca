import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasQuietReadyScreen } from './tui-idle-evidence'

const QUIESCENCE_MS = 3000

afterEach(() => {
  vi.useRealTimers()
})

describe('output clock for a stream main attached after the process last printed', () => {
  it('measures quiet from when main began receiving a stream that has printed nothing since', () => {
    vi.useFakeTimers({ now: 100_000 })
    const silent = { lastAgentStatus: null, lastOutputAt: null, outputObservedSince: 100_000 }
    expect(hasQuietReadyScreen(silent, 'codex', () => true, QUIESCENCE_MS)).toBe(false)
    vi.advanceTimersByTime(QUIESCENCE_MS)
    expect(hasQuietReadyScreen(silent, 'codex', () => true, QUIESCENCE_MS)).toBe(true)
  })
})
