import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from '../../pty-ipc-test-harness'
import { registerPtyHandlers } from '../register-handlers'

vi.mock('electron', () => import('../../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('../../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../../opencode/hook-service', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../../mimo/hook-service', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../../agent-hooks/server', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../../pi/titlebar-extension-service', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../../pwsh', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../../wsl', async (importOriginal) =>
  (await import('../../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../../telemetry/client', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../../telemetry/classify-error', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../../cli/linux-terminal-orca-cli-shim', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../../memory/pty-registry', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../../codex/codex-pane-account-registry', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../../codex/codex-state-db-backfill-recovery', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
describe('delivery resumed after a hidden drop (#33766)', () => {
  const {
    handlers,
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener
  } = setupPtyIpcSuite()

  async function hideDropAndResume(dropped: string, resumed: string) {
    vi.useFakeTimers()
    let seq = 0
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn((_id: string, _data: string, _at: number, chars: number) => (seq += chars)),
      getPtyOutputSequence: vi.fn(() => seq),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      registerPreAllocatedHandleForPty: vi.fn()
    }
    const daemon = installObservableDaemonTestProvider()
    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
      const { id } = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      })) as { id: string }
      const setHidden = getPtySetHiddenRendererPtyListener()
      setHidden(null, { id, hidden: true })
      daemon.emitData(id, dropped)
      vi.advanceTimersByTime(50)
      setHidden(null, { id, hidden: false })
      mainWindow.webContents.send.mockClear()
      daemon.emitData(id, resumed)
      vi.advanceTimersByTime(50)
      const delivered = mainWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === 'pty:data')
        .map(([, payload]) => payload as { data: string; seq?: number; rawLength?: number })
      return { delivered, seq }
    } finally {
      vi.useRealTimers()
    }
  }

  it.each([
    [
      'an OSC title',
      'done\x1b]0;Sequent',
      'ial refactoring PRs | cleanup-dumb-exports\x07> prompt'
    ],
    ['an SGR sequence', 'diff \x1b[38;5', ';242m+ line'],
    ['a CSI whose ESC alone was dropped', 'diff \x1b', '[38;5;242m+ line']
  ])('trims the rest of %s whose start was dropped', async (_name, dropped, resumed) => {
    const { delivered, seq } = await hideDropAndResume(dropped, resumed)
    const kept = resumed.slice(resumed.search(/> prompt|\+ line/))
    expect(delivered.map((payload) => payload.data).join('')).toBe(kept)
    // Seq metadata must describe the trimmed bytes so restore slicing stays exact.
    expect(delivered.at(-1)).toMatchObject({ seq, rawLength: kept.length })
  })

  it('keeps output that follows a clean drop boundary, including a bell after text', async () => {
    const { delivered } = await hideDropAndResume('hidden\x1b[0m', 'build done\x07')
    expect(delivered.map((payload) => payload.data).join('')).toBe('build done\x07')
  })
})
