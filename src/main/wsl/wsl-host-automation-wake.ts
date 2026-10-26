/**
 * E9: a WSL host's automations run inside its distro, so a stopped distro misses them. While a host
 * is connected the desktop learns when its next enabled run is due and keeps that across restarts;
 * when it comes due with the host off, this boots the distro once and orcad's startup catch-up fires
 * the run. A due run is the user's own standing request, so it is the one non-interactive wake.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Automation } from '../../shared/automations-types'

export type WslHostAutomationDue = {
  nextRunAt: number
  /** Past this, orcad would only record the run as missed, so a wake is pointless. */
  wakeUntil: number
}

export type WslHostAutomationWakeDeps = {
  load: () => Record<string, WslHostAutomationDue>
  save: (due: Record<string, WslHostAutomationDue>) => void
  listAutomations: (environmentId: string) => Promise<Automation[]>
  isConnected: (environmentId: string) => Promise<boolean>
  /** Boots the host's distro and connects; it may refuse (host removed, gate closed). */
  wake: (environmentId: string) => Promise<void>
  now?: () => number
  setTimer?: (delayMs: number, task: () => void) => () => void
}

// Re-arm at least this often, so a clock change or sleep can't strand a far-off timer.
const MAX_TIMER_MS = 60 * 60 * 1000
// orcad's own tick jitter allowance on top of each automation's grace.
const GRACE_SLACK_MS = 2 * 60 * 1000

/** The soonest enabled run, or null when nothing is scheduled. */
export function earliestWslHostAutomationDue(
  automations: readonly Automation[]
): WslHostAutomationDue | null {
  let due: WslHostAutomationDue | null = null
  for (const automation of automations) {
    if (!automation.enabled || !Number.isFinite(automation.nextRunAt)) {
      continue
    }
    if (!due || automation.nextRunAt < due.nextRunAt) {
      due = {
        nextRunAt: automation.nextRunAt,
        wakeUntil: automation.nextRunAt + automation.missedRunGraceMinutes * 60_000 + GRACE_SLACK_MS
      }
    }
  }
  return due
}

export class WslHostAutomationWake {
  private due: Record<string, WslHostAutomationDue>
  private cancelTimer: (() => void) | null = null
  private readonly now: () => number
  private readonly setTimer: (delayMs: number, task: () => void) => () => void

  constructor(private readonly deps: WslHostAutomationWakeDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer =
      deps.setTimer ??
      ((delayMs, task) => {
        const timer = setTimeout(task, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    this.due = deps.load()
  }

  /** Arms the timer from what earlier runs learned; a run due during a reboot fires now. */
  start(): void {
    this.arm()
  }

  /** Called while the host is connected; a failed read keeps what was known. */
  async learn(environmentId: string): Promise<void> {
    let next: WslHostAutomationDue | null
    try {
      next = earliestWslHostAutomationDue(await this.deps.listAutomations(environmentId))
    } catch {
      return
    }
    if (next) {
      this.due = { ...this.due, [environmentId]: next }
    } else {
      this.drop(environmentId)
    }
    this.persist()
    this.arm()
  }

  forget(environmentId: string): void {
    this.drop(environmentId)
    this.persist()
    this.arm()
  }

  dispose(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private drop(environmentId: string): void {
    const { [environmentId]: _dropped, ...rest } = this.due
    this.due = rest
  }

  private persist(): void {
    try {
      this.deps.save(this.due)
    } catch (error) {
      console.warn('[wsl-hosts] Could not save automation wake times:', error)
    }
  }

  private arm(): void {
    this.cancelTimer?.()
    const times = Object.values(this.due).map((entry) => entry.nextRunAt)
    if (times.length === 0) {
      this.cancelTimer = null
      return
    }
    const delayMs = Math.min(Math.max(0, Math.min(...times) - this.now()), MAX_TIMER_MS)
    this.cancelTimer = this.setTimer(delayMs, () => void this.fire())
  }

  private async fire(): Promise<void> {
    const now = this.now()
    for (const [environmentId, entry] of Object.entries(this.due)) {
      if (entry.nextRunAt > now) {
        continue
      }
      // Once handled, the next due time comes from the host again after it connects.
      this.drop(environmentId)
      if (now > entry.wakeUntil || (await this.deps.isConnected(environmentId))) {
        continue
      }
      await this.deps.wake(environmentId).catch((error: unknown) => {
        console.warn(`[wsl-hosts] Could not start ${environmentId} for a scheduled run:`, error)
      })
    }
    this.persist()
    this.arm()
  }
}

const FILE_NAME = 'wsl-host-automation-wakes.json'

export function readWslHostAutomationWakes(
  userDataPath: string
): Record<string, WslHostAutomationDue> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataPath, FILE_NAME), 'utf8'))
    const due: Record<string, WslHostAutomationDue> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [environmentId, value] of Object.entries(parsed)) {
        if (
          value &&
          typeof value === 'object' &&
          typeof value.nextRunAt === 'number' &&
          typeof value.wakeUntil === 'number'
        ) {
          due[environmentId] = { nextRunAt: value.nextRunAt, wakeUntil: value.wakeUntil }
        }
      }
    }
    return due
  } catch {
    return {}
  }
}

export function writeWslHostAutomationWakes(
  userDataPath: string,
  due: Record<string, WslHostAutomationDue>
): void {
  writeFileSync(join(userDataPath, FILE_NAME), JSON.stringify(due))
}
