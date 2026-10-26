import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { LaunchedAgentForeground } from './launched-agent-foreground'
import { TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import {
  confirmTrustDialogGone,
  forgetTrustDialog,
  isTrustDialogShown,
  observeTrustDialogScreenChange,
  trustDialogSettledStatus,
  trustDialogWaitingStatus
} from './startup-dialog-terminal-status'

type TrustDialogStatusDeps = {
  getPaneAgent: (ptyId: string) => TuiAgent | null
  refreshForegroundAgent: (ptyId: string) => Promise<unknown>
  readLaunchedAgentForeground: (ptyId: string, agent: TuiAgent) => Promise<LaunchedAgentForeground>
  /** False once the PTY or its emulator was replaced. */
  isCurrentEmulator: (ptyId: string, emulator: HeadlessEmulator) => boolean
  readStatus: (ptyId: string) => AgentStatusIpcPayload | undefined
  /** A sidebar projection of the blocked text agentWait already reads, never first-party agent evidence. */
  publish: (ptyId: string, payload: ParsedAgentStatusPayload) => void
}

/** Projects a Claude/Codex folder-trust dialog into the pane's status row; hooks only start after trust. */
export class TrustDialogStatusObserver {
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: TrustDialogStatusDeps) {}

  observe(ptyId: string, emulator: HeadlessEmulator, chunk: string): void {
    const read = observeTrustDialogScreenChange(emulator, chunk)
    if (read === null) {
      return
    }
    if (read !== 'appeared') {
      this.scheduleSettleCheck(ptyId, emulator)
      return
    }
    const agent = this.deps.getPaneAgent(ptyId)
    if (agent) {
      this.publishWaiting(ptyId, agent)
      return
    }
    // An agent typed into a shell paints its dialog before the foreground-process probe names it.
    void this.deps.refreshForegroundAgent(ptyId).then(() => {
      if (this.isStillShown(ptyId, emulator)) {
        this.publishWaiting(ptyId, this.deps.getPaneAgent(ptyId))
      }
    })
  }

  private publishWaiting(ptyId: string, agent: TuiAgent | null): void {
    const waiting = trustDialogWaitingStatus(agent, this.deps.readStatus(ptyId))
    if (waiting) {
      this.deps.publish(ptyId, waiting)
    }
  }

  private isStillShown(ptyId: string, emulator: HeadlessEmulator): boolean {
    return this.deps.isCurrentEmulator(ptyId, emulator) && isTrustDialogShown(emulator)
  }

  /** Settles only on positive evidence once output goes quiet, so a repaint split across reads never re-notifies. */
  private scheduleSettleCheck(ptyId: string, emulator: HeadlessEmulator): void {
    clearTimeout(this.settleTimers.get(ptyId))
    const timer = setTimeout(() => {
      this.settleTimers.delete(ptyId)
      void this.settle(ptyId, emulator)
    }, TUI_IDLE_QUIESCENCE_MS)
    timer.unref?.()
    this.settleTimers.set(ptyId, timer)
  }

  private async settle(ptyId: string, emulator: HeadlessEmulator): Promise<void> {
    if (!this.isStillShown(ptyId, emulator)) {
      return
    }
    const settled = trustDialogSettledStatus(this.deps.readStatus(ptyId))
    const agent =
      settled?.agentType === 'claude' ? 'claude' : settled?.agentType === 'codex' ? 'codex' : null
    // A hook that reported since owns the pane: stop tracking without touching its row.
    if (!agent) {
      forgetTrustDialog(emulator)
      return
    }
    if (!confirmTrustDialogGone(emulator)) {
      // A killed agent can leave its frame painted above the shell prompt; only a proven shell foreground settles it.
      const foreground = await this.deps.readLaunchedAgentForeground(ptyId, agent)
      if (foreground !== 'shell' || !this.isStillShown(ptyId, emulator)) {
        return
      }
      forgetTrustDialog(emulator)
    }
    const stillOurs = trustDialogSettledStatus(this.deps.readStatus(ptyId))
    if (stillOurs) {
      this.deps.publish(ptyId, stillOurs)
    }
  }
}
