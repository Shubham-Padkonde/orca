type MainDaemonAttachmentDependencies = {
  isUnattachedLocalCandidate: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
}

/** Who holds a session's stream: an attach in flight, a stream this run holds, or one an endpoint drop detached. */
type StreamState =
  | { kind: 'attaching'; restoring: boolean; attempt: Promise<boolean> }
  | { kind: 'attached' }
  | { kind: 'lost' }

// Why capped: 100 concurrent snapshot attaches delayed the visible terminal's first echo by ~0.7 s.
const MAX_CONCURRENT_ATTACHES = 4

/** Main holds the stream for every live local daemon session it adopts, so its records fill without a mounted pane. */
export class MainDaemonAttachments {
  private readonly states = new Map<string, StreamState>()
  private readonly inventoryWaiters = new Set<string>()
  private readonly queued: (() => void)[] = []
  private running = 0

  constructor(private readonly deps: MainDaemonAttachmentDependencies) {}

  /** This run's spawn or a pane's attach already carries the stream. */
  markSpawnPublished(ptyId: string): void {
    this.states.set(ptyId, { kind: 'attached' })
  }

  /** Respawn or exit ends the generation whose stream this state described. */
  forget(ptyId: string): void {
    this.states.delete(ptyId)
    this.inventoryWaiters.delete(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.states.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
  }

  hasPendingAttach(ptyId: string): boolean {
    return this.states.get(ptyId)?.kind === 'attaching'
  }

  inventoryWaiterIds(): string[] {
    return [...this.inventoryWaiters]
  }

  /** Inventory proved the session live; attach it, or retry once an in-flight refusal settles. */
  reconcile(ptyId: string): void {
    const state = this.states.get(ptyId)
    if (state?.kind !== 'attaching') {
      this.ensure(ptyId)
      return
    }
    if (this.inventoryWaiters.has(ptyId)) {
      return
    }
    this.inventoryWaiters.add(ptyId)
    void state.attempt.then(() => {
      this.inventoryWaiters.delete(ptyId)
      this.ensure(ptyId)
    })
  }

  /** An endpoint drop detached a stream no pane will restore; re-attach it once the daemon answers. */
  reattachAfterEndpointLoss(ptyId: string): void {
    this.states.set(ptyId, { kind: 'lost' })
    this.ensure(ptyId)
  }

  ensure(ptyId: string): void {
    void this.ensureAttached(ptyId)
  }

  /** Null when the stream needs nothing from main; otherwise whether an attach (or retry) got it. */
  ensureAttached(ptyId: string): Promise<boolean> | null {
    const state = this.states.get(ptyId)
    if (state?.kind === 'attaching') {
      return state.attempt
    }
    const restoring = state?.kind === 'lost'
    if (state?.kind === 'attached' || (!restoring && !this.isKnownUnattachedLocal(ptyId))) {
      return null
    }
    const attaching: StreamState = { kind: 'attaching', restoring, attempt: Promise.resolve(false) }
    this.states.set(ptyId, attaching)
    attaching.attempt = this.attach(ptyId, attaching).then((attached) => {
      if (this.states.get(ptyId) === attaching) {
        if (attached) {
          this.states.set(ptyId, { kind: 'attached' })
        } else if (restoring) {
          this.states.set(ptyId, { kind: 'lost' })
        } else {
          this.states.delete(ptyId)
        }
      }
      return attached
    })
    return attaching.attempt
  }

  private async attach(ptyId: string, attaching: StreamState): Promise<boolean> {
    if (this.running >= MAX_CONCURRENT_ATTACHES) {
      // The finishing attach hands its slot over without releasing it.
      await new Promise<void>((resolve) => this.queued.push(resolve))
    } else {
      this.running += 1
    }
    try {
      // A pane's attach or a respawn replaced this state while it waited.
      if (this.states.get(ptyId) !== attaching) {
        return this.states.get(ptyId)?.kind === 'attached'
      }
      return (await this.deps.attachProvider(ptyId)) ?? false
    } catch {
      return false
    } finally {
      const next = this.queued.shift()
      if (next) {
        next()
      } else {
        this.running -= 1
      }
    }
  }
}
