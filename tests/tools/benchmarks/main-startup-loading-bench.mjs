import { _electron as electron } from '@stablyai/playwright-test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  descendantsOf,
  readProcessRows,
  terminateProcesses
} from '../../../config/scripts/idle-cpu-process-sampling.mjs'

const options = { appRoot: process.cwd(), output: null, idleMs: 120_000, runs: 3 }
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (name === '--app-root') {
    options.appRoot = resolve(value)
  } else if (name === '--output') {
    options.output = resolve(value)
  } else if (name === '--idle-ms') {
    options.idleMs = Number(value)
  } else if (name === '--runs') {
    options.runs = Number(value)
  } else {
    throw new Error(`Unknown argument: ${name}`)
  }
}
if (
  !Number.isSafeInteger(options.runs) ||
  options.runs < 1 ||
  !Number.isSafeInteger(options.idleMs) ||
  options.idleMs < 0
) {
  throw new Error('runs must be positive and idle-ms must be nonnegative integers')
}

const results = []
for (let run = 0; run < options.runs; run += 1) {
  const profile = mkdtempSync(join(tmpdir(), 'orca-main-loading-'))
  try {
    const isolatedHome = join(profile, 'home')
    mkdirSync(isolatedHome)
    const { ELECTRON_RUN_AS_NODE, CODEX_HOME, ORCA_CODEX_HOME, ...cleanEnv } = process.env
    void ELECTRON_RUN_AS_NODE
    void CODEX_HOME
    void ORCA_CODEX_HOME
    const started = Date.now()
    const app = await electron.launch({
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        join(options.appRoot, 'out', 'main', 'index.js')
      ],
      env: {
        ...cleanEnv,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        NODE_ENV: 'development',
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_DEV_USER_DATA_PATH: join(profile, 'userData'),
        ORCA_TELEMETRY_DISABLED: '1'
      },
      timeout: 120_000
    })
    const pid = app.process().pid
    if (process.env.ORCA_MAIN_LOADING_TRACE === '1') {
      app.process().stderr?.on('data', (data) => process.stderr.write(data))
    }
    try {
      const page = await app.firstWindow({ timeout: 120_000 })
      await page.waitForLoadState('domcontentloaded')
      const loadedMs = Date.now() - started
      await page.waitForTimeout(options.idleMs)
      const sample = await app.evaluate(async ({ app }) => {
        const module = process.getBuiltinModule('module')
        const require = module.createRequire(`${app.getAppPath()}/package.json`)
        const loadedFiles = Object.keys(require.cache)
        return {
          pid: process.pid,
          memory: process.memoryUsage(),
          processMemory: await process.getProcessMemoryInfo(),
          heap: process.getBuiltinModule('v8').getHeapStatistics(),
          loadedChunks: loadedFiles.filter((file) => /[\\/]out[\\/]main[\\/]/.test(file)),
          loadedDependencies: loadedFiles.filter((file) => /[\\/]node_modules[\\/]/.test(file)),
          dependencyParents: loadedFiles
            .filter((file) => /[\\/]node_modules[\\/](yaml|ssh2|posthog-node)[\\/]/.test(file))
            .map((file) => ({ file, parent: require.cache[file].parent?.filename })),
          windowCount: app.getAppMetrics().filter((entry) => entry.type === 'Tab').length,
          windows: require('electron')
            .BrowserWindow.getAllWindows()
            .map((window) => ({
              visible: window.isVisible(),
              url: window.webContents.getURL()
            }))
        }
      })
      if (sample.windows.some((window) => window.visible)) {
        throw new Error('Benchmark window was presented; refusing invalid background evidence')
      }
      results.push({ run: run + 1, loadedMs, idleMs: options.idleMs, ...sample })
      console.log(JSON.stringify({ run: run + 1, loadedMs, memory: sample.memory }))
    } finally {
      let children = []
      try {
        children = descendantsOf(readProcessRows(), pid)
      } finally {
        await app.close().catch(() => {})
        terminateProcesses(children)
      }
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}
const report = {
  appRoot: options.appRoot,
  platform: process.platform,
  arch: process.arch,
  presentation: 'hidden',
  telemetry: 'disabled',
  results
}
if (options.output) {
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`)
} else {
  console.log(JSON.stringify(report, null, 2))
}
