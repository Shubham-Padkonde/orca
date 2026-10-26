/** C7: persist WSL hosts and connect for explicit Add/Connect or visible project/terminal demand. Never boot stopped distros for background work. */
import { errorMessage } from '../../shared/error-message'
import { setWslHostPendingStop } from '../../shared/runtime-environment-wsl-host-store'
import {
  readWslHostDeployments,
  type WslHostDeploymentRecord
} from '../../shared/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostConnectIntent,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { persistWslHostConnection, toWslHostStatus } from './wsl-host-connection-record'
import {
  sameWslDistro,
  wslHostNotConnectedMessage,
  wslHostRemovalPendingMessage,
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { registerWslHost } from './wsl-host-registration'
import { removeWslHostServer, type WslHostRemoval } from './wsl-host-removal'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

/** The WSL side the service drives: C3 holder, C5 connections, C6 liveness (or an e2e fake). */
export type WslHostConnector = {
  listDistros(): Promise<WslHostDistroCandidate[]>
  /** Runs in the distro, so it boots a stopped one: only after the user chose to. */
  readOrcadPublicKey(distro: string): Promise<string | null>
  /** User-initiated; may boot the distro. An intent retries or forces a skipped update. */
  connect(distro: string, options?: { intent?: WslHostConnectIntent }): Promise<WslOrcadConnection>
  /** Explicit retry must clear pairing-repair failures and spent caps. */
  forgetPairingFailures?(environmentId: string): void
  get(distro: string): WslOrcadConnection | null
  /** Checks the paired server without starting a stopped or unconfirmed distro. */
  isReachable(distro: string, environmentId: string): Promise<boolean>
  disconnect(distro: string): Promise<void>
  /** Ends the host's terminals, orcad and its terminal daemon; never boots a stopped distro. */
  stopServer(distro: string, environmentId: string): Promise<WslHostServerStop>
  /** Registry and `--list --running` only, so it never boots the distro. */
  distroPresence(distro: string, distroId?: string): Promise<WslDistroPresence>
  releaseHolder(distro: string): Promise<void>
  /** Startup: keeps the holders an earlier run left and releases those `isWanted` refuses. */
  adoptHolders(isWanted: (distro: string) => boolean): Promise<void>
  dispose(): Promise<void>
}

export type WslDistroPresence = 'running' | 'stopped' | 'unregistered' | 'unverifiable'

export type WslHostServiceDependencies = {
  userDataPath: () => string
  isEnabled: () => boolean
  /** Whether this build ships the orcad template a WSL host deploys from. */
  hasServerFiles: () => boolean
  publish: (status: WslHostStatus) => void
  /** The environment's pairing changed: transports that authenticate with the old one retire. */
  pairingChanged: (environmentId: string) => void
  /** A connection came up: verify the server now rather than on the status owner's backoff. */
  ready: (environmentId: string) => void
  removed: (environmentId: string) => Promise<void> | void
}

export class WslHostService {
  private connector: WslHostConnector | null = null
  private readonly statuses = new Map<string, WslHostStatus>()
  private readonly adding = new Map<string, Promise<WslHostAddResult>>()
  private visible = new Set<string>()
  private readonly removing = new Set<string>()
  // Invalidate in-flight Adds when disabled so they cannot later publish ready hosts.
  private disableGeneration = 0
  private readonly statusListeners = new Set<() => void>()

  constructor(private readonly deps: WslHostServiceDependencies) {}

  /** Two-phase so the connector's `onChange` can call back into this service. */
  attach(connector: WslHostConnector): void {
    this.connector = connector
  }

  private get wsl(): WslHostConnector {
    if (!this.connector) {
      throw new Error('WSL hosts are not available on this computer.')
    }
    return this.connector
  }

  /** C5's `onChange`: persist what moved, then tell the UI. */
  handleConnectionChange(
    distro: string,
    connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus
  ): void {
    const record = this.recordForDistro(distro)
    if (!record) {
      return
    }
    if (connection && persistWslHostConnection(this.deps.userDataPath(), record, connection)) {
      this.deps.pairingChanged(record.environmentId)
    }
    this.setStatus(record, status, connection)
    if (status.state === 'ready' && connection) {
      this.deps.ready(record.environmentId)
    }
  }

  getStatuses(): WslHostStatus[] {
    return [...this.statuses.values()]
  }

  /** Hears every change to what `getStatuses` returns. */
  onStatusesChanged(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  private notifyStatusesChanged(): void {
    for (const listener of this.statusListeners) {
      listener()
    }
  }

  async listDistros(): Promise<WslHostDistro[]> {
    const records = this.records()
    const candidates = await this.wsl.listDistros()
    return candidates.map(({ id: _id, ...distro }) => ({
      ...distro,
      environmentId:
        records.find((record) => sameWslDistro(record.distro, distro.name))?.environmentId ?? null
    }))
  }

  add(args: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> {
    const key = wslDistroHolderKey(args.distro)
    const pending = this.adding.get(key)
    if (pending) {
      return pending
    }
    const unfinishedRemoval = this.recordForDistro(args.distro)
    if (unfinishedRemoval?.pendingStop) {
      // Adding it again keeps the host its unfinished Remove left listed.
      const { environmentId } = unfinishedRemoval
      return this.connect(environmentId).then(
        (): WslHostAddResult => ({ ok: true, environmentId }),
        (error: unknown): WslHostAddResult => ({
          ok: false,
          kind: 'failed',
          message: errorMessage(error)
        })
      )
    }
    const operation = registerWslHost(
      {
        deps: this.deps,
        wsl: () => this.wsl,
        disableGeneration: () => this.disableGeneration,
        recordForDistro: (distro) => this.recordForDistro(distro),
        recordForEnvironment: (environmentId) => this.recordForEnvironment(environmentId),
        setReady: (record, connection) =>
          this.setStatus(record, { state: 'ready', census: null }, connection)
      },
      args
    ).finally(() => this.adding.delete(key))
    this.adding.set(key, operation)
    return operation
  }

  async remove(environmentId: string): Promise<WslHostServerStop> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    // Block reconnect from visible work, liveness and calls before stopping.
    this.removing.add(environmentId)
    let removal: WslHostRemoval
    try {
      removal = await removeWslHostServer(this.deps.userDataPath(), this.connector, record)
      if (removal.removed) {
        this.visible.delete(environmentId)
      }
    } finally {
      // Failed removal must leave the host usable and allow another removal attempt.
      this.removing.delete(environmentId)
    }
    if (!removal.removed) {
      this.setStatus(this.recordForEnvironment(environmentId) ?? record, { state: 'closed' })
      return removal.serverStop
    }
    this.statuses.delete(environmentId)
    this.notifyStatusesChanged()
    await this.deps.removed(environmentId)
    return removal.serverStop
  }

  /** Disable closes connections/watches and releases holders; reenable resumes only hosts needed by visible work. */
  async enabledChanged(enabled: boolean): Promise<void> {
    const connector = this.connector
    if (!connector) {
      return
    }
    if (enabled) {
      this.setVisibleWork([...this.visible], new Set())
      return
    }
    this.disableGeneration += 1
    for (const record of this.records()) {
      await connector.disconnect(record.distro)
      await connector.releaseHolder(record.distro)
      this.setStatus(record, { state: 'closed' })
    }
  }

  /** The user asked for this host: may boot its distro. An intent retries or forces an update. */
  async connect(
    environmentId: string,
    options: { intent?: WslHostConnectIntent } = {}
  ): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    if (record.pendingStop) {
      // Connecting keeps the host: its unfinished Remove is withdrawn.
      setWslHostPendingStop(this.deps.userDataPath(), environmentId, null)
    }
    this.wsl.forgetPairingFailures?.(environmentId)
    await this.wsl.connect(record.distro, options)
  }

  /** Serve existing connections; reconnect only for visible work, otherwise return a WSL-specific refusal rather than an unreachable-network error. */
  async ensureForRuntimeCall(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    const connector = this.connector
    if (!record || !connector || (await connector.isReachable(record.distro, environmentId))) {
      return
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    if (record.pendingStop) {
      throw new Error(wslHostRemovalPendingMessage(record.distro))
    }
    if (!this.visible.has(environmentId)) {
      throw new Error(wslHostNotConnectedMessage(record.distro))
    }
    await connector.connect(record.distro)
  }

  /** Whether anything may still be started for this distro (spawn guard). */
  isKnownDistro(distro: string): boolean {
    return this.adding.has(wslDistroHolderKey(distro)) || this.recordForDistro(distro) !== null
  }

  setVisibleWork(environmentIds: readonly string[], previous = this.visible): void {
    this.visible = new Set(environmentIds.filter((id) => !this.removing.has(id)))
    if (!this.connector || !this.canRun()) {
      return
    }
    for (const environmentId of this.visible) {
      const record = !previous.has(environmentId) && this.recordForEnvironment(environmentId)
      if (record && !record.pendingStop) {
        this.ensureForRuntimeCall(environmentId).catch((error: unknown) => {
          console.warn(`[wsl-hosts] Could not connect to ${record.distro}:`, error)
        })
      }
    }
  }

  hasUserVisibleWork(distro: string): boolean {
    const record = this.recordForDistro(distro)
    // Liveness needs visible demand, an enabled gate and no removal in progress.
    const id = record?.environmentId
    return id && !record.pendingStop
      ? this.canRun() && this.visible.has(id) && !this.removing.has(id)
      : false
  }

  /**
   * Startup: keep the holders a previous run left for its hosts, without booting anything. A
   * holder for a distro that is no longer a host (a failed add or remove), or any holder while
   * hosts are off, would keep its distro running forever, so it is released.
   */
  async start(): Promise<void> {
    if (!this.connector) {
      return
    }
    // An unfinished Remove shows as such from launch; nothing reconnects it.
    for (const record of this.records()) {
      if (record.pendingStop) {
        this.setStatus(record, { state: 'closed' })
      }
    }
    const canRun = this.canRun()
    await this.connector.adoptHolders((distro) => canRun && this.isKnownDistro(distro))
  }

  /** What the UI shows before offering any WSL host action. */
  hasServerFiles(): boolean {
    return this.deps.hasServerFiles()
  }

  private canRun(): boolean {
    return wslHostRunRefusal(this.deps) === null
  }

  async dispose(): Promise<void> {
    await this.connector?.dispose()
  }

  private setStatus(
    record: WslHostDeploymentRecord,
    status: WslOrcadConnectionStatus,
    connection: WslOrcadConnection | null = null
  ): void {
    const next = toWslHostStatus(record, status, connection)
    this.statuses.set(record.environmentId, next)
    this.deps.publish(next)
    this.notifyStatusesChanged()
  }

  private records(): WslHostDeploymentRecord[] {
    try {
      return readWslHostDeployments(this.deps.userDataPath()).deployments
    } catch (error) {
      console.warn('[wsl-hosts] Could not read WSL host records:', error)
      return []
    }
  }

  private recordForDistro(distro: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => sameWslDistro(record.distro, distro)) ?? null
  }

  /** The registered WSL host behind an environment; null for any other environment. */
  recordForEnvironment(environmentId: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => record.environmentId === environmentId) ?? null
  }
}
