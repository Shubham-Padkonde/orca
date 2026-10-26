import { toast } from 'sonner'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { runEnclosingWorktreeRemoval } from '@/store/active-worktree-deselection-intent'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'

/** Stop terminals/server, remove records and refresh hosts; report anything still running that keeps the distro alive. */
async function removeWslHostImpl(environmentId: string): Promise<void> {
  const api = window.api.runtimeEnvironments?.wslHosts
  if (!api) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  const serverStop = await api.remove({ environmentId })
  const state = useAppStore.getState()
  // Clear activation so the removed host stops receiving workspace calls, though its records remain listed.
  if (
    state.activeWorktreeId &&
    workspaceOwnerHostId(state, state.activeWorktreeId) === toRuntimeExecutionHostId(environmentId)
  ) {
    state.setActiveWorktree(null)
  }
  state.setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  if (serverStop?.stopped === false && serverStop.kept) {
    // E11: a stop Orca couldn't prove keeps the host listed, so Remove can retry it.
    toast.warning(
      translate(
        'auto.components.sidebar.wslHostRemoval.pending',
        'Orca didn’t remove the host yet: {{value0}} Remove it again to retry, or connect it to keep it.',
        { value0: serverStop.reason }
      ),
      { duration: Infinity }
    )
    return
  }
  // Why `=== false`: an older main answered nothing here.
  if (serverStop?.stopped === false) {
    // Why it stays up: it names what still runs in the distro, which the user has to act on.
    toast.warning(
      translate(
        'auto.components.sidebar.wslHostRemoval.partial',
        'The host was removed, but something in the distro is still running: {{value0}}',
        { value0: serverStop.reason }
      ),
      { duration: Infinity }
    )
  }
}

export async function removeWslHost(environmentId: string): Promise<void> {
  return runEnclosingWorktreeRemoval({ hostId: toRuntimeExecutionHostId(environmentId) }, () =>
    removeWslHostImpl(environmentId)
  )
}
