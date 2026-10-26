import type {
  AgentStatusIpcPayload,
  AgentType,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { findTerminalWaitBlockedSignal } from './agent-state-rules/blocked-text-layer'

const TRUST_DIALOG_TOOL_INPUT = 'Trust this folder?'

/** pendingBytes: output still allowed to finish painting a dialog whose keyword was seen. */
type TrustDialogScan = { pendingBytes: number; shown: boolean; carry: string }

const scans = new WeakMap<HeadlessEmulator, TrustDialogScan>()

// Cell-diff painters (Claude's Ink) replace spaces with cursor moves, so match one word, not the phrase.
const TRUST_KEYWORD_RE = /trust/i
const TRUST_KEYWORD_CARRY_CHARS = 'trust'.length - 1
const TRUST_DIALOG_PAINT_BYTES = 4096

// A live dialog ends on its key footer with the trust choice just above; quoted dialog text in a reply does not.
const TRUST_DIALOG_FOOTER_RE = /^(?:enter to confirm · esc to cancel|enter continue · esc quit)$/
const TRUST_DIALOG_CHOICE_RE =
  /^(?:[❯›]\s*)?(?:\d+\.\s*)?(?:yes, i trust this folder|trust and continue)$/
const TRUST_DIALOG_CHOICE_ROWS = 6

function isTrustDialogOnScreen(emulator: HeadlessEmulator): boolean {
  const lines = emulator
    .getVisibleLines()
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
  if (!TRUST_DIALOG_FOOTER_RE.test(lines.at(-1) ?? '')) {
    return false
  }
  if (
    !lines.slice(-TRUST_DIALOG_CHOICE_ROWS, -1).some((line) => TRUST_DIALOG_CHOICE_RE.test(line))
  ) {
    return false
  }
  const reason = findTerminalWaitBlockedSignal(lines.join('\n'))?.reason
  return reason === 'agent-trust-workspace' || reason === 'codex-trust-workspace'
}

/** True/false when a folder-trust dialog appears on/leaves the screen; null when unchanged. */
export function observeTrustDialogScreenChange(
  emulator: HeadlessEmulator,
  data: string
): boolean | null {
  let scan = scans.get(emulator)
  if (!scan) {
    scan = { pendingBytes: 0, shown: false, carry: '' }
    scans.set(emulator, scan)
  }
  // The carry catches the keyword split across PTY reads without copying the chunk.
  const seam = scan.carry + data.slice(0, TRUST_KEYWORD_CARRY_CHARS)
  if (TRUST_KEYWORD_RE.test(data) || TRUST_KEYWORD_RE.test(seam)) {
    scan.pendingBytes = TRUST_DIALOG_PAINT_BYTES
  }
  scan.carry = (scan.carry + data.slice(-TRUST_KEYWORD_CARRY_CHARS)).slice(
    -TRUST_KEYWORD_CARRY_CHARS
  )
  // A frame still being painted may lack rows the next chunk restores.
  if ((scan.pendingBytes <= 0 && !scan.shown) || emulator.isSynchronizedOutput) {
    return null
  }
  const onScreen = isTrustDialogOnScreen(emulator)
  scan.pendingBytes = onScreen ? 0 : scan.pendingBytes - data.length
  if (onScreen === scan.shown) {
    return null
  }
  scan.shown = onScreen
  return onScreen
}

/** The agent left: stop reading the screen until the keyword is painted again. */
export function forgetTrustDialog(emulator: HeadlessEmulator): void {
  scans.delete(emulator)
}

export function isTrustDialogShown(emulator: HeadlessEmulator): boolean {
  return scans.get(emulator)?.shown === true
}

/** Hooks start only after folder trust, so a live hook row means the trust text is history. */
export function trustDialogWaitingStatus(
  agent: AgentType | null,
  row: AgentStatusIpcPayload | undefined
): ParsedAgentStatusPayload | null {
  // Only Claude's and Codex's dialogs are verified to precede their hooks and repaint without flicker.
  if (agent !== 'claude' && agent !== 'codex') {
    return null
  }
  if (row && row.observation?.origin === 'hook' && !row.providerSessionOnly) {
    return null
  }
  return { state: 'waiting', agentType: agent, prompt: '', toolInput: TRUST_DIALOG_TOOL_INPUT }
}

/** Settles only the row this dialog wrote; a hook that reported since owns the pane. */
export function trustDialogSettledStatus(
  row: AgentStatusIpcPayload | undefined
): ParsedAgentStatusPayload | null {
  if (row?.state !== 'waiting' || row.toolInput !== TRUST_DIALOG_TOOL_INPUT) {
    return null
  }
  // A session boundary, not a finished turn: no notification or unread badge.
  return { state: 'done', agentType: row.agentType, prompt: '', sessionBoundary: true }
}
