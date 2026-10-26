import { isAbortSignalReason, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** Local preparation only: no journal or wire representation. */
export type StructuredAgentSessionPreparedAdmission = (
  offer: (requestedAt: number) => Promise<void>,
  currentTurn: () => string | null
) => Promise<void>

/** Only an unwritten preparation may unwind before the journal writer finishes. */
export async function waitPreparedCommit(
  admission: Promise<unknown>,
  signal: AbortSignal | undefined,
  offered: () => Promise<void> | undefined,
  reporting: { logger?: StructuredAgentSessionLogger }
): Promise<void> {
  try {
    await waitForPromiseWithSignal(admission, signal)
  } catch (error) {
    if (!isAbortSignalReason(signal, error)) {
      throw error
    }
    if (offered()) {
      await admission
      return
    }
    void admission.catch((lateError: unknown) => {
      if (!isAbortSignalReason(signal, lateError)) {
        reporting.logger?.warn('recording a cancelled prepared input failed', {
          scope: 'prepared-input',
          error: lateError
        })
      }
    })
    throw error
  }
}
