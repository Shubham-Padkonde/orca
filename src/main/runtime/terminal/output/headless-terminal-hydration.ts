import type {
  RuntimeHeadlessTerminal,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import { splitFreebuffScreenUpdates } from '../../../../shared/freebuff-screen-status'
import { OrcaRuntimeWithSerializeMainTerminalBuffer } from './terminal-buffer-operations'
import { observeFreebuffTerminalStatus } from '../../freebuff-terminal-status'
import {
  observeCodexCapacityTerminalStatus,
  observeCodexReconnectFailure
} from '../../codex-notice-terminal-status'
import {
  isTrustDialogShown,
  observeTrustDialogScreenChange,
  trustDialogSettledStatus,
  trustDialogWaitingStatus
} from '../../startup-dialog-terminal-status'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../shared/terminal-scrollback-policy'
import {
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from '../../../../shared/agent-detection'
import { shouldModelAnswerHiddenPtyQueries } from '../../terminal-model-query-authority'

export abstract class OrcaRuntimeWithMaybeHydrateHeadlessFromRenderer extends OrcaRuntimeWithSerializeMainTerminalBuffer {
  protected abstract getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal
  protected abstract markPaneLiveTitlesDirty(): void
  protected abstract settleLostAgentSession(ptyId: string): void

  // Create emulator state synchronously and chain renderer hydration first so concurrent live bytes cannot be overwritten by a late seed (docs/mobile-prefer-renderer-scrollback.md).
  maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<boolean> | null {
    if (this.headlessHydrationState.has(ptyId)) {
      return null
    }
    const providerSnapshotPreferred = this.providerSnapshotPreferredPtys.has(ptyId)
    if (this.headlessTerminals.has(ptyId) && !providerSnapshotPreferred) {
      // Daemon-snapshot seed already populated the emulator — skip hydration.
      this.headlessHydrationState.set(ptyId, 'done')
      return null
    }
    const controller = this.ptyController
    if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
      return null
    }
    if (!controller.hasRendererSerializer(ptyId)) {
      // Renderer hasn't registered yet (or never will). Live writes lazy-
      // create the state via trackHeadlessTerminalData on this same tick.
      return null
    }

    if (providerSnapshotPreferred) {
      // Why: a stream byte can create a partial model before restored history
      // arrives. A mounted renderer snapshot can safely replace that model.
      this.disposeHeadlessTerminal(ptyId)
    }

    this.headlessHydrationState.set(ptyId, 'pending')
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    // Why: hydration writes below never set forwardQueryReplies (main-side
    // replay guard) — renderer-buffer snapshots can embed stale queries.
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.getPtyOutputSequence(ptyId)
    this.headlessTerminals.set(ptyId, state)

    // Queue seed before live writes on the same state; awaiting before publishing state would lose concurrent bytes.
    let seeded = false
    state.writeChain = state.writeChain.then(async () => {
      if (this.headlessTerminals.get(ptyId) !== state) {
        return
      }
      try {
        // Retain normal-buffer scrollback while a TUI is in alt-screen so pre-TUI history remains restorable (#6106).
        // Desktop depth (this emulator's retention): a hidden-output reveal repaints the pane from this model.
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
        })
        if (
          this.headlessTerminals.get(ptyId) !== state ||
          !rendered ||
          rendered.data.length === 0
        ) {
          return
        }
        this.recordOsc7MetadataForPty(ptyId, rendered.data)
        this.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
        // Resize to renderer's dims so the seed reflows correctly into the
        // emulator's grid, then resize back to PTY dims (if known) so live
        // writes use the correct cell layout.
        if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
          state.emulator.resize(rendered.cols, rendered.rows)
        }
        await state.emulator.write(rendered.data)
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        const ptyDims = this.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          state.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        // Synthetic hook titles bypass xterm; prefer main's tracked title, using renderer title only for a cold tracker.
        state.ownership.seedOwner(undefined, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        const seedTitle = this.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
        if (seedTitle) {
          state.emulator.setLastTitle(seedTitle)
          this.applySeededAgentStatus(ptyId, seedTitle)
        }
        this.providerSnapshotPreferredPtys.delete(ptyId)
        seeded = true
      } catch {
        // Hydration is best-effort. Live writes continue via the same
        // writeChain that this catch-arm leaves intact.
      } finally {
        if (this.headlessTerminals.get(ptyId) === state) {
          this.headlessHydrationState.set(ptyId, 'done')
        }
      }
    })
    return state.writeChain.then(() => seeded)
  }

  // Historical seeds update display status only, never live evidence, waiters or orchestration delivery.
  protected applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    // Seed cold title trackers for completion/stale-working timers; observed live titles always win.
    this.getOrCreatePtyTitleTrackerEntry(ptyId).tracker.seedInitialTitle(title)
    const status = detectAgentStatusFromTitle(title)
    // Store normalized title evidence like live output; display clears still project over native working titles.
    const seededTitle = normalizeTerminalTitle(title)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const observedAt = this.nextTitleObservationSequence()
      pty.lastOscTitle = seededTitle
      pty.lastOscTitleAt = observedAt
      this.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Seed even non-agent titles so worktree.ps can reclassify instead of treating the pane as agentless.
      leaf.lastOscTitle = seededTitle
      leaf.lastOscTitleAt = this.nextTitleObservationSequence()
      if (status !== null) {
        leaf.lastAgentStatus = status
      }
    }
    this.markPaneLiveTitlesDirty()
  }

  /** Capture reply ownership synchronously at ingestion; never re-read it when the queued write runs. */
  protected shouldAnswerQueriesForLiveChunk(ptyId: string): boolean {
    return shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: this.store?.getSettings(),
      hasRemoteViewSubscriber: this.hasRemoteTerminalViewSubscriber(ptyId)
    })
  }

  protected trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): void {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const outputObservedAt = Date.now()
    const completion = state.writeChain.then(async () => {
      // Capture reply ownership at ingestion, then scan inside the chain so live bytes and seeds retain total order.
      state.ownership.scan(data)
      for (const chunk of splitFreebuffScreenUpdates(data, state.emulator.partialEscapeTailAnsi)) {
        await state.emulator.write(chunk, { forwardQueryReplies })
        const pty = this.ptysById.get(ptyId)
        if (!pty || this.headlessTerminals.get(ptyId) !== state) {
          continue
        }
        const command = this.terminalSpawnCommandsByPtyId.get(ptyId)
        const readStatus = () => this.readPtyAgentStatusRow(ptyId, pty)
        // Remote hosts report status themselves, but only this runtime can settle its own dispatches.
        if (
          observeCodexReconnectFailure(state.emulator, chunk, command, pty.launchAgent, readStatus)
        ) {
          this.settleLostAgentSession(ptyId)
        }
        if (!pty.connectionId) {
          // Runs every chunk: its scan tracks when the dialog leaves the screen.
          this.observeTrustDialogStatus(ptyId, pty, state, chunk, readStatus)
          const payload =
            observeCodexCapacityTerminalStatus(
              state.emulator,
              chunk,
              command,
              pty.launchAgent,
              readStatus,
              outputObservedAt
            ) ?? observeFreebuffTerminalStatus(state.emulator, chunk, command, pty.launchAgent)
          if (payload) {
            pty.lastExplicitAgentStatus = {
              state: payload.state,
              updatedAt: Date.now(),
              sessionBoundary: payload.sessionBoundary
            }
            this.emitTerminalAgentStatusEvents(ptyId, {
              cleanData: '',
              payloads: [payload],
              lastPayloadCleanOffset: null
            })
          }
        }
      }
      state.outputSequence = outputSequence
    })
    state.writeChain = completion.catch(() => {})
  }

  private readPtyAgentStatusRow(
    ptyId: string,
    pty: RuntimePtyWorktreeRecord
  ): AgentStatusIpcPayload | undefined {
    const paneKey =
      this.getLeavesForPty(ptyId).map((leaf) => this.makeRuntimePaneKey(leaf))[0] ??
      this.paneOfPty(pty).paneKey
    return paneKey ? this.getAgentStatusSnapshotForPaneFn?.(paneKey)[0] : undefined
  }

  /** A sidebar projection of the blocked text agentWait already reads, never first-party agent evidence. */
  private publishTrustDialogStatus(ptyId: string, payload: ParsedAgentStatusPayload): void {
    this.emitTerminalAgentStatusEvents(
      ptyId,
      { cleanData: '', payloads: [payload], lastPayloadCleanOffset: null },
      undefined,
      false
    )
  }

  private observeTrustDialogStatus(
    ptyId: string,
    pty: RuntimePtyWorktreeRecord,
    state: RuntimeHeadlessTerminal,
    chunk: string,
    readStatus: () => AgentStatusIpcPayload | undefined
  ): void {
    const shown = observeTrustDialogScreenChange(state.emulator, chunk)
    if (shown === null) {
      return
    }
    if (!shown) {
      const settled = trustDialogSettledStatus(readStatus())
      if (settled) {
        this.publishTrustDialogStatus(ptyId, settled)
      }
      return
    }
    const agent = this.getPaneAgentForTuiIdle(ptyId)
    if (agent) {
      const waiting = trustDialogWaitingStatus(agent, readStatus())
      if (waiting) {
        this.publishTrustDialogStatus(ptyId, waiting)
      }
      return
    }
    // An agent typed into a shell paints its dialog before the foreground-process probe names it.
    void this.ptyForegroundAgent.refresh(ptyId).then(() => {
      if (
        this.ptysById.get(ptyId) !== pty ||
        this.headlessTerminals.get(ptyId) !== state ||
        !isTrustDialogShown(state.emulator)
      ) {
        return
      }
      const waiting = trustDialogWaitingStatus(
        this.getPaneAgentForTuiIdle(ptyId),
        this.readPtyAgentStatusRow(ptyId, pty)
      )
      if (waiting) {
        this.publishTrustDialogStatus(ptyId, waiting)
      }
    })
  }
}
