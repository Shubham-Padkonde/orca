import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as telemetryClient from './client'
import {
  makeFakeSettings,
  makeFakeStore,
  makeMockPostHog,
  type MockPostHog
} from './client-test-harness'

describe('deferred telemetry transport', () => {
  let client: typeof telemetryClient
  let sdk: MockPostHog
  let moduleLoads: number
  const createClient = vi.fn()
  const settings = makeFakeSettings({
    installId: 'startup-test',
    optedIn: true,
    existedBeforeTelemetryRelease: false
  })
  const store = makeFakeStore(settings)

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('ORCA_BUILD_IDENTITY', 'stable')
    vi.stubGlobal('ORCA_POSTHOG_WRITE_KEY', 'test-key')
    for (const key of [
      'DO_NOT_TRACK',
      'ORCA_TELEMETRY_DISABLED',
      'CI',
      'GITHUB_ACTIONS',
      'GITLAB_CI',
      'CIRCLECI',
      'TRAVIS',
      'BUILDKITE',
      'JENKINS_URL',
      'TEAMCITY_VERSION'
    ]) {
      vi.stubEnv(key, undefined)
    }
    moduleLoads = 0
    sdk = makeMockPostHog()
    createClient.mockReset().mockReturnValue(sdk)
    vi.doMock('./posthog-transport', () => {
      moduleLoads += 1
      return { createPostHogClient: createClient }
    })
    settings.telemetry = {
      installId: 'startup-test',
      optedIn: true,
      existedBeforeTelemetryRelease: false
    }
    client = await import('./client')
    client.initTelemetry(store)
  })

  afterEach(async () => {
    await client.shutdownTelemetry()
    vi.doUnmock('./posthog-transport')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('queues validated startup captures without loading the SDK and flushes once after paint', async () => {
    expect(client.track('app_opened', {})).toBe(true)
    expect(client.track('telemetry_opted_in', { via: 'settings' })).toBe(true)
    expect(client.track('app_opened', { nth_repo_added: Number.NaN })).toBe(false)
    expect(moduleLoads).toBe(0)
    expect(sdk.capture).not.toHaveBeenCalled()

    const first = client.startTelemetryTransport()
    expect(client.startTelemetryTransport()).toBe(first)
    await first
    await client.startTelemetryTransport()

    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
      'app_opened',
      'telemetry_opted_in'
    ])
  })

  it.each(['user', 'environment', 'contributor'] as const)(
    'does not import or construct the SDK for disabled %s startup',
    async (reason) => {
      if (reason === 'user') {
        settings.telemetry!.optedIn = false
      } else if (reason === 'environment') {
        vi.stubEnv('DO_NOT_TRACK', '1')
      } else {
        vi.stubGlobal('ORCA_BUILD_IDENTITY', null)
        vi.resetModules()
        client = await import('./client')
        client.initTelemetry(store)
      }
      expect(client.track('app_opened', {})).toBe(false)
      await client.startTelemetryTransport()
      expect(moduleLoads).toBe(0)
      expect(createClient).not.toHaveBeenCalled()
    }
  )

  it('checks consent again before constructing a client and discards opted-out captures', async () => {
    client.track('app_opened', {})
    const loading = client.startTelemetryTransport()
    settings.telemetry!.optedIn = false
    await loading
    expect(createClient).not.toHaveBeenCalled()
    settings.telemetry!.optedIn = true
    await client.startTelemetryTransport()
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it('does not construct a late client after shutdown', async () => {
    client.track('app_opened', {})
    const loading = client.startTelemetryTransport()
    await client.shutdownTelemetry()
    await loading
    expect(createClient).not.toHaveBeenCalled()
    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it('retries app_opened after consent drops its queued capture', async () => {
    client.trackAppOpenedOnce()
    await client.setOptIn('settings', false)
    await client.setOptIn('settings', true)
    expect(
      sdk.capture.mock.calls.filter(([capture]) => capture.event === 'app_opened')
    ).toHaveLength(1)
  })

  it('retains bounded startup captures across a failed first initialization', async () => {
    client.track('app_opened', {})
    createClient.mockImplementationOnce(() => {
      throw new Error('transport unavailable')
    })
    await expect(client.startTelemetryTransport()).rejects.toThrow('transport unavailable')
    await client.startTelemetryTransport()
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(sdk.capture).toHaveBeenCalledTimes(1)
  })

  it('bounds the startup queue even when event rate limits refill', async () => {
    const now = vi.spyOn(Date, 'now')
    for (let index = 0; index < 101; index += 1) {
      now.mockReturnValue(index * 60_000)
      expect(client.track('app_opened', {})).toBe(index < 100)
    }
    expect(client.isTelemetryEnabled()).toBe(false)
    await client.startTelemetryTransport()
    expect(sdk.capture).toHaveBeenCalledTimes(100)
  })
})
