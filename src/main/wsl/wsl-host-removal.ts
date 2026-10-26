/**
 * Removing a WSL host (E11). Only a proven stop drops its records; anything else keeps the host
 * listed with a pending stop, so the next Remove retries it and Connect or Add can keep the host.
 * Dropping it would strand a still-running server that blocks the next add's activation.
 */
import { errorMessage } from '../../shared/error-message'
import {
  removeWslHostEnvironment,
  setWslHostPendingStop
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { WslHostConnector } from './wsl-host-service'

export type WslHostRemoval = { serverStop: WslHostServerStop; removed: boolean }

/** Why a pending stop is still pending without touching a distro that is not running. */
async function pendingStopBlocker(
  connector: WslHostConnector,
  record: WslHostDeploymentRecord
): Promise<WslHostServerStop | 'gone' | null> {
  const presence = await connector
    .distroPresence(record.distro, record.distroId)
    .catch(() => 'unverifiable' as const)
  if (presence === 'unregistered') {
    return 'gone'
  }
  if (!record.pendingStop || presence === 'running') {
    return null
  }
  return {
    stopped: false,
    verdict: 'unverifiable',
    reason:
      presence === 'stopped'
        ? `Start ${record.distro} to finish removing it.`
        : `Orca couldn’t tell whether ${record.distro} is running.`
  }
}

export async function removeWslHostServer(
  userDataPath: string,
  connector: WslHostConnector | null,
  record: WslHostDeploymentRecord
): Promise<WslHostRemoval> {
  let serverStop: WslHostServerStop = { stopped: true }
  if (connector) {
    const blocker = await pendingStopBlocker(connector, record)
    // A distro that is no longer registered runs nothing of this host.
    if (blocker !== 'gone') {
      serverStop =
        blocker ??
        (await connector
          .stopServer(record.distro, record.environmentId)
          .catch((error: unknown): WslHostServerStop => ({
            stopped: false,
            verdict: 'unverifiable',
            reason: errorMessage(error)
          })))
    }
    await connector.disconnect(record.distro)
    // Without its holder the distro idles out, pending or not.
    await connector.releaseHolder(record.distro)
  }
  if (serverStop.stopped) {
    removeWslHostEnvironment(userDataPath, record.environmentId)
    return { serverStop, removed: true }
  }
  setWslHostPendingStop(userDataPath, record.environmentId, {
    since: Date.now(),
    reason: serverStop.reason,
    verdict: serverStop.verdict ?? 'unverifiable'
  })
  return { serverStop: { ...serverStop, kept: true }, removed: false }
}
