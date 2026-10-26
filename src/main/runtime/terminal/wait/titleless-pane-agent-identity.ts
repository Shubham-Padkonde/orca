import { detectTerminalWaitBlockedReason } from '../../terminal-wait-detection'
import {
  OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission,
  type TerminalInteractiveWaitEvidence
} from './terminal-wait-permission'

export abstract class OrcaRuntimeWithTitlelessPaneAgentIdentity extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  /** A hand-typed agent's startup dialogs emit no title, so no title transition asked which process owns the pane. */
  protected override readTerminalInteractiveWaitEvidence(
    handle: string,
    ptyId: string
  ): TerminalInteractiveWaitEvidence | Promise<TerminalInteractiveWaitEvidence | undefined> {
    const { terminal } = this.getTerminalWaitPermissionInputs(handle, ptyId)
    // Only dialog-shaped output earns a foreground read; plain shells and editors answer synchronously.
    const identity =
      terminal.titleStatus === null &&
      detectTerminalWaitBlockedReason(
        this.readLiveTerminalScreenLines(ptyId)?.join('\n') ?? terminal.waitText
      ) !== null &&
      this.ptyForegroundAgent.identifyUnowned(ptyId)
    if (!identity) {
      return super.readTerminalInteractiveWaitEvidence(handle, ptyId)
    }
    // A timed-out scan cannot rule out a dialog, so it answers unknown rather than none.
    return identity.then((agent) =>
      agent === undefined
        ? undefined
        : super.readTerminalInteractiveWaitEvidence(handle, ptyId, agent)
    )
  }
}
