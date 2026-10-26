/** Resumed delivery after a hidden drop must not start inside an escape whose start was dropped, or the renderer prints its tail (#33766). */
import {
  advanceTerminalEscapeBoundary,
  openEscapeContinuationLength
} from '../../../../shared/terminal-partial-escape-tail'

// Escape-parser state at the end of each PTY's accepted renderer stream.
const escapeBoundaryByPty = new Map<string, string>()
// Escape left open by bytes the hidden gate dropped; trimmed from the next delivered chunk.
const openEscapeAtResumeByPty = new Map<string, string>()

export function observeRendererBoundPtyData(id: string, data: string): void {
  const boundary = advanceTerminalEscapeBoundary(escapeBoundaryByPty.get(id) ?? '', data)
  if (boundary) {
    escapeBoundaryByPty.set(id, boundary)
  } else {
    escapeBoundaryByPty.delete(id)
  }
}

/** Call after dropping every accepted byte so far; the open escape (if any) is the one resumed bytes would continue. */
export function armEscapeResumeAfterHiddenDrop(id: string): void {
  const boundary = escapeBoundaryByPty.get(id)
  if (boundary) {
    openEscapeAtResumeByPty.set(id, boundary)
  } else {
    openEscapeAtResumeByPty.delete(id)
  }
}

/** A snapshot captured at the gap carries the open escape itself, so the next live bytes must complete it. */
export function disarmEscapeResumeForSnapshot(id: string): void {
  openEscapeAtResumeByPty.delete(id)
}

/** Leading chars of a chunk delivered after a hidden drop that belong to the dropped escape. */
export function takeOrphanedEscapeContinuationLength(id: string, data: string): number {
  const open = openEscapeAtResumeByPty.get(id)
  if (!open) {
    return 0
  }
  const length = openEscapeContinuationLength(open, data)
  if (length !== -1) {
    openEscapeAtResumeByPty.delete(id)
    return length
  }
  openEscapeAtResumeByPty.set(id, advanceTerminalEscapeBoundary(open, data))
  return data.length
}

export function clearHiddenDropEscapeResumeState(id: string): void {
  escapeBoundaryByPty.delete(id)
  openEscapeAtResumeByPty.delete(id)
}

export function _resetHiddenDropEscapeResumeForTest(): void {
  escapeBoundaryByPty.clear()
  openEscapeAtResumeByPty.clear()
}
