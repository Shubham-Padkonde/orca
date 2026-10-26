import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import {
  earliestWslHostAutomationDue,
  readWslHostAutomationWakes,
  WslHostAutomationWake,
  writeWslHostAutomationWakes,
  type WslHostAutomationDue
} from './wsl-host-automation-wake'

const HOUR = 60 * 60 * 1000

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a',
    name: 'nightly',
    prompt: '',
    precheck: null,
    agentId: 'claude',
    projectId: 'p',
    executionTargetType: 'local',
    executionTargetId: 'p',
    schedulerOwner: 'remote_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 10 * HOUR,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function harness(options: { due?: Record<string, WslHostAutomationDue>; connected?: boolean }) {
  let now = 0
  let timer: { at: number; task: () => void } | null = null
  const saved: Record<string, WslHostAutomationDue>[] = []
  const wake = vi.fn(async (_environmentId: string) => {})
  const automations = vi.fn(async (): Promise<Automation[]> => [automation({})])
  const subject = new WslHostAutomationWake({
    load: () => options.due ?? {},
    save: (due) => saved.push(due),
    listAutomations: automations,
    isConnected: async () => options.connected ?? false,
    wake,
    now: () => now,
    setTimer: (delayMs, task) => {
      timer = { at: now + delayMs, task }
      return () => {
        timer = null
      }
    }
  })
  return {
    subject,
    wake,
    automations,
    saved,
    timerAt: () => timer?.at ?? null,
    /** Moves the clock to the armed timer and runs it. */
    async runTimer(at: number) {
      now = at
      const current = timer
      const savesBefore = saved.length
      timer = null
      current?.task()
      await vi.waitFor(() => expect(saved.length).toBeGreaterThan(savesBefore))
    }
  }
}

describe('earliestWslHostAutomationDue', () => {
  it('takes the soonest enabled run and its grace window', () => {
    expect(
      earliestWslHostAutomationDue([
        automation({ nextRunAt: 5 * HOUR, enabled: false }),
        automation({ nextRunAt: 8 * HOUR, missedRunGraceMinutes: 60 }),
        automation({ nextRunAt: 9 * HOUR })
      ])
    ).toEqual({ nextRunAt: 8 * HOUR, wakeUntil: 9 * HOUR + 2 * 60_000 })
    expect(earliestWslHostAutomationDue([automation({ enabled: false })])).toBeNull()
  })
})

describe('WslHostAutomationWake', () => {
  it('boots the host once when a learned run comes due with the host off', async () => {
    const h = harness({})
    await h.subject.learn('wsl:ubuntu')
    expect(h.timerAt()).toBe(HOUR) // capped re-arm, not 10 h
    await h.runTimer(HOUR)
    expect(h.wake).not.toHaveBeenCalled()
    await h.runTimer(10 * HOUR)
    expect(h.wake).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
    expect(h.saved.at(-1)).toEqual({})
    expect(h.timerAt()).toBeNull()
  })

  it('fires a run that came due while the computer was off as soon as Orca starts', async () => {
    const h = harness({ due: { 'wsl:ubuntu': { nextRunAt: -HOUR, wakeUntil: 11 * HOUR } } })
    h.subject.start()
    expect(h.timerAt()).toBe(0)
    await h.runTimer(0)
    expect(h.wake).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
  })

  it('does not wake for a run past its grace, or a host that is already connected', async () => {
    const late = harness({ due: { 'wsl:ubuntu': { nextRunAt: -2 * HOUR, wakeUntil: -HOUR } } })
    late.subject.start()
    await late.runTimer(0)
    const connected = harness({
      due: { 'wsl:ubuntu': { nextRunAt: -HOUR, wakeUntil: HOUR } },
      connected: true
    })
    connected.subject.start()
    await connected.runTimer(0)
    expect(late.wake).not.toHaveBeenCalled()
    expect(connected.wake).not.toHaveBeenCalled()
  })

  it('keeps what it knew when the host cannot be read, and forgets a removed host', async () => {
    const h = harness({ due: { 'wsl:ubuntu': { nextRunAt: 5 * HOUR, wakeUntil: 6 * HOUR } } })
    h.automations.mockRejectedValueOnce(new Error('offline'))
    await h.subject.learn('wsl:ubuntu')
    expect(h.saved).toEqual([])
    h.subject.forget('wsl:ubuntu')
    expect(h.saved.at(-1)).toEqual({})
    expect(h.timerAt()).toBeNull()
  })
})

describe('persisted wake times', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips and drops malformed entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-'))
    writeWslHostAutomationWakes(dir, { a: { nextRunAt: 1, wakeUntil: 2 } })
    expect(readWslHostAutomationWakes(dir)).toEqual({ a: { nextRunAt: 1, wakeUntil: 2 } })
    expect(readWslHostAutomationWakes(join(dir, 'missing'))).toEqual({})
  })
})
