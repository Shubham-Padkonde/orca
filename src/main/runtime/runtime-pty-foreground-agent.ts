import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { withTimeoutResult } from './runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  PtyForegroundAgentRefresh,
  PtyForegroundProcessRead,
  PtyForegroundProcessReadEntry
} from './runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type Dependencies = {
  getController(): RuntimePtyController | null
  getPty(ptyId: string): RuntimePtyWorktreeRecord | null
  touchSnapshot(ptyId: string): void
  finishDelayedSnapshot(ptyId: string, changed: boolean): void
}

export class RuntimePtyForegroundAgent {
  private readonly refreshes = new Map<string, PtyForegroundAgentRefresh>()
  private readonly reads = new Map<string, PtyForegroundProcessReadEntry>()
  private readonly delayedTitles = new Map<string, number>()
  // A scan's verdict for an unfamiliar name holds while that name stays in the foreground.
  private readonly confirmedByPtyId = new Map<
    string,
    { foregroundName: string; agent: TerminalAgent | null }
  >()

  constructor(private readonly deps: Dependencies) {}

  read(ptyId: string, afterTitle = 0): Promise<PtyForegroundProcessRead> | null {
    const controller = this.deps.getController()
    if (!controller) {
      return null
    }
    const pending = this.reads.get(ptyId)
    if (pending?.controller === controller && pending.startedAfterTitleObservation >= afterTitle) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      return pending.promise.then(
        () => this.read(ptyId, afterTitle) ?? { controller, process: null, available: false }
      )
    }
    const unavailable: PtyForegroundProcessRead = { controller, process: null, available: false }
    let processRead: Promise<string | null>
    try {
      processRead = Promise.resolve(controller.getForegroundProcess(ptyId))
    } catch {
      const entry: PtyForegroundProcessReadEntry = {
        controller,
        startedAfterTitleObservation: afterTitle,
        promise: Promise.resolve(unavailable)
      }
      entry.promise = entry.promise.finally(() => this.deleteRead(ptyId, entry))
      this.reads.set(ptyId, entry)
      return entry.promise
    }
    let entry: PtyForegroundProcessReadEntry
    const promise = processRead
      .then((process) => ({ controller, process, available: true }))
      .catch(() => unavailable)
      .finally(() => this.deleteRead(ptyId, entry))
    entry = { controller, startedAfterTitleObservation: afterTitle, promise }
    this.reads.set(ptyId, entry)
    return entry.promise
  }

  refresh(ptyId: string, afterTitle = 0): Promise<boolean> {
    const pending = this.refreshes.get(ptyId)
    if (pending) {
      pending.requestedAfterTitleObservation = Math.max(
        pending.requestedAfterTitleObservation,
        afterTitle
      )
      return pending.promise
    }
    const entry: PtyForegroundAgentRefresh = {
      promise: Promise.resolve(false),
      startedAfterTitleObservation: afterTitle,
      requestedAfterTitleObservation: afterTitle
    }
    entry.promise = (async () => {
      while (true) {
        entry.startedAfterTitleObservation = entry.requestedAfterTitleObservation
        const changed = await this.load(ptyId, entry.startedAfterTitleObservation)
        if (changed || entry.requestedAfterTitleObservation <= entry.startedAfterTitleObservation) {
          return changed
        }
      }
    })().finally(() => {
      if (this.refreshes.get(ptyId) === entry) {
        this.refreshes.delete(ptyId)
      }
    })
    this.refreshes.set(ptyId, entry)
    return entry.promise
  }

  /** Null when launch, foreground, or command evidence already owns the pane; false when the scan timed out. */
  identifyUnowned(ptyId: string): Promise<boolean> | null {
    const pty = this.deps.getPty(ptyId)
    if (!pty || (pty.launchAgent ?? pty.foregroundAgent ?? pty.launchCommandAgent)) {
      return null
    }
    return withTimeoutResult(
      this.load(ptyId, 0, true),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS
    ).then((result) => result.ok)
  }

  getPending(ptyId: string, afterTitle: number): Promise<boolean> | undefined {
    return this.refreshes.has(ptyId) ? this.refresh(ptyId, afterTitle) : undefined
  }

  getReads(): ReadonlyMap<string, PtyForegroundProcessReadEntry> {
    return this.reads
  }

  delaySnapshot(ptyId: string, titleAt: number, refresh: Promise<boolean>): void {
    this.delayedTitles.set(ptyId, titleAt)
    void refresh.then((changed) => {
      if (this.delayedTitles.get(ptyId) !== titleAt) {
        return
      }
      this.delayedTitles.delete(ptyId)
      this.deps.finishDelayedSnapshot(ptyId, changed)
    })
  }

  hasDelayedSnapshot(ptyId: string): boolean {
    return this.delayedTitles.has(ptyId)
  }

  forget(ptyId: string): void {
    this.delayedTitles.delete(ptyId)
    this.confirmedByPtyId.delete(ptyId)
  }

  private async load(
    ptyId: string,
    afterTitle: number,
    confirmUnfamiliar = false
  ): Promise<boolean> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected || pty.launchAgent) {
      return false
    }
    const result = await this.read(ptyId, afterTitle)
    if (!result || result.controller !== this.deps.getController() || !result.available) {
      return false
    }
    const foregroundName = result.process
    let agent = recognizeAgentProcess(foregroundName)?.agent ?? null
    // Native Claude's p_comm is its version (2.1.310); only a process-table scan reads its argv.
    if (!agent && foregroundName && !isShellProcess(foregroundName)) {
      const confirmed = this.confirmedByPtyId.get(ptyId)
      if (confirmed?.foregroundName === foregroundName) {
        agent = confirmed.agent
      } else if (confirmUnfamiliar) {
        agent = recognizeAgentProcess(await this.confirm(result.controller, ptyId))?.agent ?? null
        if (result.controller !== this.deps.getController()) {
          return false
        }
        this.confirmedByPtyId.set(ptyId, { foregroundName, agent })
      }
    } else {
      this.confirmedByPtyId.delete(ptyId)
    }
    if (pty.foregroundAgent === agent) {
      return false
    }
    pty.foregroundAgent = agent
    this.deps.touchSnapshot(ptyId)
    return true
  }

  private async confirm(controller: RuntimePtyController, ptyId: string): Promise<string | null> {
    try {
      return (await controller.confirmForegroundProcess?.(ptyId)) ?? null
    } catch {
      return null
    }
  }

  private deleteRead(ptyId: string, entry: PtyForegroundProcessReadEntry): void {
    if (this.reads.get(ptyId) === entry) {
      this.reads.delete(ptyId)
    }
  }
}
