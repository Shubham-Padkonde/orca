type MainDaemonAttachmentDependencies = {
  isUnattachedLocalCandidate: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
}

// Why capped: 100 concurrent snapshot attaches delayed the visible terminal's first echo by ~0.7 s.
const MAX_CONCURRENT_ATTACHES = 4

/** Main holds the stream for every live local daemon session it adopts, so its records fill without a mounted pane. */
export class MainDaemonAttachments {
  private readonly attaches = new Map<string, Promise<boolean>>()
  private readonly inventoryWaiters = new Set<string>()
  private readonly spawnPublishedPtys = new Set<string>()
  // Endpoint loss detached these; they need a re-attach although main already holds their model.
  private readonly lostPtys = new Set<string>()
  private readonly queued: (() => void)[] = []
  private running = 0

  constructor(private readonly deps: MainDaemonAttachmentDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.spawnPublishedPtys.add(ptyId)
  }

  resetGeneration(ptyId: string): void {
    this.attaches.delete(ptyId)
    this.inventoryWaiters.delete(ptyId)
    this.spawnPublishedPtys.delete(ptyId)
    this.lostPtys.delete(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.spawnPublishedPtys.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
  }

  hasPendingAttach(ptyId: string): boolean {
    return this.attaches.has(ptyId)
  }

  inventoryWaiterIds(): string[] {
    return [...this.inventoryWaiters]
  }

  /** Inventory proved the session live; attach it, or retry once an in-flight refusal settles. */
  reconcile(ptyId: string): void {
    const pending = this.attaches.get(ptyId)
    if (!pending) {
      this.ensure(ptyId)
      return
    }
    if (this.inventoryWaiters.has(ptyId)) {
      return
    }
    this.inventoryWaiters.add(ptyId)
    void pending.then((attached) => {
      this.inventoryWaiters.delete(ptyId)
      if (attached) {
        return
      }
      if (this.attaches.get(ptyId) === pending) {
        this.attaches.delete(ptyId)
      }
      this.ensure(ptyId)
    })
  }

  /** A dropped daemon endpoint detaches every stream; panes remount, sessions without one re-attach here. */
  reattachAfterEndpointLoss(ptyId: string): void {
    this.attaches.delete(ptyId)
    this.lostPtys.add(ptyId)
    this.ensure(ptyId)
  }

  ensure(ptyId: string): void {
    if (
      this.attaches.has(ptyId) ||
      (!this.lostPtys.has(ptyId) && !this.isKnownUnattachedLocal(ptyId))
    ) {
      return
    }
    const attempt = this.attach(ptyId)
    this.attaches.set(ptyId, attempt)
    void attempt.then((attached) => {
      if (this.attaches.get(ptyId) !== attempt) {
        return
      }
      if (attached) {
        this.lostPtys.delete(ptyId)
      } else {
        this.attaches.delete(ptyId)
      }
    })
  }

  private async attach(ptyId: string): Promise<boolean> {
    if (this.running >= MAX_CONCURRENT_ATTACHES) {
      // The finishing attach hands its slot over without releasing it.
      await new Promise<void>((resolve) => this.queued.push(resolve))
    } else {
      this.running += 1
    }
    try {
      // A pane may have attached, or the session respawned, while this waited.
      if (!this.lostPtys.has(ptyId) && !this.isKnownUnattachedLocal(ptyId)) {
        return false
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
