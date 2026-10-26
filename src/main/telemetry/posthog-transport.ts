import { PostHog } from 'posthog-node'
import type { EventName } from '../../shared/telemetry-events'
import type { ConsentState } from './consent'
import { shouldOptOutSdkAtInit } from './consent'

const OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS = 1_000

export function waitForCaptureEnqueue(
  client: PostHog,
  event: EventName,
  uuid: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let stopListening: (() => void) | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (enqueued: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      stopListening?.()
      resolve(enqueued)
    }

    // Node SDK capture enqueues asynchronously; observe its event before opting out.
    stopListening = client.on('capture', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      if (
        'event' in payload &&
        payload.event === event &&
        'uuid' in payload &&
        payload.uuid === uuid
      ) {
        settle(true)
      }
    })

    timeout = setTimeout(() => settle(false), OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS)
  })
}

export function createPostHogClient(writeKey: string, consent: ConsentState): PostHog {
  const client = new PostHog(writeKey, {
    host: 'https://us.i.posthog.com',
    flushAt: 20,
    flushInterval: 10_000,
    // Disable SDK GeoIP/IP enrichment to keep the wire inside the declared allow-list.
    disableGeoip: true,
    // Increase offline buffer from 1000 to 5000; overflow drops oldest events.
    maxQueueSize: 5000
  })

  if (shouldOptOutSdkAtInit(consent)) {
    client.optOut()
  }
  return client
}
