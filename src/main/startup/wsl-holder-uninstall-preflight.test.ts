import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { WslDistroHolder, WslDistroHolderAdoption } from '../wsl/wsl-distro-holder'

vi.mock('electron', () => ({
  app: { exit: vi.fn(), getPath: () => '/user-data', setPath: vi.fn() }
}))

import {
  releaseWslHoldersForUninstall,
  WSL_HOLDER_UNINSTALL_FLAG
} from './wsl-holder-uninstall-preflight'

function holder(release: () => Promise<WslDistroHolderAdoption[]>): WslDistroHolder {
  return {
    ensureHeld: vi.fn(),
    adoptHolders: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(release),
    holderState: vi.fn()
  }
}

describe('WSL holder release on uninstall', () => {
  it('succeeds only when every recorded holder is proven gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      releaseWslHoldersForUninstall(holder(async () => [{ distro: 'ubuntu', state: 'exited' }]))
    ).resolves.toBe(0)
    await expect(releaseWslHoldersForUninstall(holder(async () => []))).resolves.toBe(0)
    await expect(
      releaseWslHoldersForUninstall(
        holder(async () => [
          { distro: 'ubuntu', state: 'exited' },
          { distro: 'debian', state: 'unverifiable' }
        ])
      )
    ).resolves.toBe(1)
    await expect(
      releaseWslHoldersForUninstall(
        holder(async () => {
          throw new Error('table unreadable')
        })
      )
    ).resolves.toBe(1)
  })

  it('runs from the uninstaller only, after the app and its daemon are gone', () => {
    const hooks = readFileSync(
      new URL('../../../config/nsis/orca-installer-hooks.nsh', import.meta.url),
      'utf8'
    )
    const unInstall = hooks.slice(hooks.indexOf('!macro customUnInstall'))
    const realUninstall = unInstall.slice(
      unInstall.indexOf('${ifNot} ${isUpdated}'),
      // The real-uninstall branch ends with the relocated daemon host's cleanup.
      unInstall.indexOf('daemon-host-profiles')
    )
    const release = realUninstall.indexOf(
      `nsExec::Exec '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${WSL_HOLDER_UNINSTALL_FLAG}'`
    )
    expect(release).toBeGreaterThan(-1)
    // Killed first, so no running Orca can respawn a holder behind the release.
    expect(release).toBeGreaterThan(realUninstall.indexOf('orca-terminal-daemon.exe'))
    expect(hooks.split(WSL_HOLDER_UNINSTALL_FLAG)).toHaveLength(2)
  })
})
