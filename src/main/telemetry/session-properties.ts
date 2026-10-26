import { arch, platform, release } from 'node:os'
import { getAppEnvironment } from '../../shared/app-environment'
import type { CommonProps } from '../../shared/telemetry-events'

export function buildCommonProps(
  installId: string,
  sessionId: string,
  channel: 'stable' | 'rc'
): CommonProps {
  return {
    app_version: getAppEnvironment().getVersion(),
    platform: platform(),
    arch: arch(),
    os_release: release(),
    install_id: installId,
    session_id: sessionId,
    orca_channel: channel
  }
}
