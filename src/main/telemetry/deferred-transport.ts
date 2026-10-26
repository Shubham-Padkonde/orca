import type { PostHog } from 'posthog-node'
import type { ConsentState } from './consent'

type Capture = Parameters<PostHog['capture']>[0]
type TransportOptions = { writeKey: string; consent: ConsentState }
const MAX_PENDING_CAPTURES = 100

export class DeferredTelemetryTransport {
  client: PostHog | null = null
  private generation = 0
  private loading: Promise<void> | null = null
  private stopped = false
  private readonly pending: Capture[] = []

  constructor(
    private readonly readOptions: () => TransportOptions | null,
    private readonly onDiscard: (captures: readonly Capture[]) => void
  ) {}

  get accepting(): boolean {
    return !this.stopped && (this.client !== null || this.pending.length < MAX_PENDING_CAPTURES)
  }

  reset(): void {
    this.generation += 1
    this.loading = null
    this.client = null
    this.stopped = false
    this.discardPending()
  }

  discardPending(): void {
    this.onDiscard(this.pending)
    this.pending.length = 0
  }

  capture(capture: Capture): boolean {
    if (!this.accepting || this.client?.optedOut) {
      return false
    }
    if (this.client) {
      this.client.capture(capture)
    } else {
      this.pending.push(capture)
    }
    return true
  }

  start(): Promise<void> {
    if (this.loading) {
      return this.loading
    }
    const options = this.readOptions()
    if (this.client || this.stopped || !options || options.consent.effective === 'disabled') {
      return Promise.resolve()
    }
    const generation = this.generation
    const start = import('./posthog-transport').then(({ createPostHogClient }) => {
      if (generation !== this.generation || this.stopped) {
        return
      }
      const current = this.readOptions()
      if (!current || current.consent.effective === 'disabled') {
        this.discardPending()
        return
      }
      this.client = createPostHogClient(current.writeKey, current.consent)
      if (current.consent.effective === 'enabled') {
        const captures = this.pending.splice(0)
        for (const capture of captures) {
          this.client.capture(capture)
        }
      } else {
        this.discardPending()
      }
    })
    this.loading = start.finally(() => {
      if (generation === this.generation) {
        this.loading = null
      }
    })
    return this.loading
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.discardPending()
    try {
      await this.client?.shutdown(2_000)
    } catch (error) {
      console.warn('[telemetry] shutdown error (ignored):', error)
    }
  }
}
