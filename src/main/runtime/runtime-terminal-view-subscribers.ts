type RuntimeTerminalViewSubscriberDependencies = {
  notifyPresenceChanged: (ptyId: string) => void
  hasMobileSubscribers: (ptyId: string) => boolean
  ensureProviderAttach: (ptyId: string) => void
}

type PausableRemoteView = { isOutputPaused: () => boolean }

export class RuntimeTerminalViewSubscribers {
  private readonly remoteCounts = new Map<string, number>()
  private readonly pausableRemoteViews = new Map<string, Set<PausableRemoteView>>()
  private readonly rawCounts = new Map<string, number>()

  constructor(private readonly deps: RuntimeTerminalViewSubscriberDependencies) {}

  // Why: exit drops subscribers only; attach/publish state survives until the respawn advances the generation.
  clearSubscribers(ptyId: string): void {
    this.remoteCounts.delete(ptyId)
    this.pausableRemoteViews.delete(ptyId)
    this.rawCounts.delete(ptyId)
  }

  registerRemote(ptyId: string, isOutputPaused?: () => boolean): () => void {
    this.remoteCounts.set(ptyId, (this.remoteCounts.get(ptyId) ?? 0) + 1)
    const view = isOutputPaused ? { isOutputPaused } : null
    if (view) {
      const views = this.pausableRemoteViews.get(ptyId) ?? new Set()
      views.add(view)
      this.pausableRemoteViews.set(ptyId, views)
    }
    this.deps.ensureProviderAttach(ptyId)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      this.decrement(this.remoteCounts, ptyId)
      const views = this.pausableRemoteViews.get(ptyId)
      if (view && views?.delete(view) && views.size === 0) {
        this.pausableRemoteViews.delete(ptyId)
      }
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  registerRaw(ptyId: string): () => void {
    this.rawCounts.set(ptyId, (this.rawCounts.get(ptyId) ?? 0) + 1)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      this.decrement(this.rawCounts, ptyId)
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  hasRaw(ptyId: string): boolean {
    return (this.rawCounts.get(ptyId) ?? 0) > 0 || this.hasRemote(ptyId)
  }

  hasRemote(ptyId: string): boolean {
    return (this.remoteCounts.get(ptyId) ?? 0) > 0 || this.deps.hasMobileSubscribers(ptyId)
  }

  /** A remote view that will receive output now; a paused one drops it, so cannot answer its queries. */
  hasRemoteReceivingOutput(ptyId: string): boolean {
    if (this.deps.hasMobileSubscribers(ptyId)) {
      return true
    }
    let paused = 0
    for (const view of this.pausableRemoteViews.get(ptyId) ?? []) {
      if (view.isOutputPaused()) {
        paused += 1
      }
    }
    return (this.remoteCounts.get(ptyId) ?? 0) > paused
  }

  private decrement(counts: Map<string, number>, ptyId: string): void {
    const next = (counts.get(ptyId) ?? 1) - 1
    if (next <= 0) {
      counts.delete(ptyId)
    } else {
      counts.set(ptyId, next)
    }
  }

  private releaseOnce(release: () => void): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      release()
    }
  }
}
