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
    const identity =
      this.getTerminalWaitPermissionInputs(handle, ptyId).terminal.titleStatus === null &&
      this.ptyForegroundAgent.identifyUnowned(ptyId)
    if (!identity) {
      return super.readTerminalInteractiveWaitEvidence(handle, ptyId)
    }
    // A timed-out scan cannot rule out a dialog, so it answers unknown rather than none.
    return identity.then((identified) =>
      identified ? super.readTerminalInteractiveWaitEvidence(handle, ptyId) : undefined
    )
  }
}
