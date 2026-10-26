import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { dispatchClaudeTurn } from '../../claude/claude-structured-dispatch'
import * as claude from '../../claude/claude-structured-dispatch-test-support'
import { resolveClaudeReplayTurn } from '../../claude/claude-replay-turn-resolution'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { beginSubmissionHandover } from './structured-agent-session-handover'
import { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { structuredAgentSessionHandingOver } from './structured-agent-session-handing-over'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'

it.each(['before', 'late-error', 'offered', 'fold-error', 'admission-error'] as const)(
  'keeps prepared Claude cancellation and receipt custody at %s',
  async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-prepared-unwind-'))
    const journals = createTrackedJournalOpener()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const send = vi.fn().mockResolvedValue(undefined)
    const session = claude.sessionFor(send)
    const aborts = new StructuredAgentSessionAcquireAborts()
    const warn = vi.fn()
    const failure = new Error('raw admission failed')
    let frameDone = false
    let task: Promise<() => Promise<void>> | undefined
    let pending: Awaited<ReturnType<typeof beginSubmissionHandover>> = null
    try {
      const journal = await journals.open({
        stateDirectory: root,
        identity: {
          sessionId: 'prepared',
          workspaceId: 'workspace',
          hostId: 'local',
          agent: 'claude',
          providerHandle: null
        }
      })
      const body = claude.userMessage([{ type: 'text', text: 'same original' }])
      await journal.appendSubmission({
        clientMessageId: 'original',
        payloadFingerprint: '0'.repeat(64),
        body,
        fence: 0
      })
      const before = boundary === 'before' || boundary === 'late-error'
      const raw = journal.resolveDispatch.bind(journal)
      vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (input, cards, receipt) => {
        if (!receipt) {
          return raw(input, cards)
        }
        if (before || boundary === 'admission-error') {
          entered.resolve()
          await gate.promise
          if (boundary !== 'before') {
            throw failure
          }
          return raw(input, cards, receipt)
        }
        const result = raw(input, cards, receipt)
        await result
        entered.resolve()
        await gate.promise
        if (boundary === 'fold-error') {
          throw failure
        }
        return result
      })
      const ctx: AgentSessionHandoverContext = {
        sessionId: 'prepared',
        journal,
        fence: 0,
        agents: claudeAndCodexDeclared(),
        record: () => null,
        childWork: () => [],
        childWorkOpen: () => false,
        now: () => 123,
        acquireAborts: aborts,
        logger: { warn, error: vi.fn() },
        adapter: {
          open: vi.fn(),
          acquire: vi.fn(),
          cancelTurn: vi.fn(),
          answerPrompt: vi.fn(),
          setOption: vi.fn(),
          dispatch: async (input) => {
            try {
              return await dispatchClaudeTurn(session, input)
            } finally {
              frameDone = true
            }
          }
        }
      }
      const current = () => true
      const submission = journal.submission('original')!
      pending = await beginSubmissionHandover(ctx, submission, current, current, current)
      const owner = structuredAgentSessionHandingOver(journal).get('original')!.input!.owner
      task = pending!.dispatch()
      await entered.promise
      expect(frameDone).toBe(false)
      expect(structuredAgentSessionHandingOver(journal).get('original')!.input!.owner).toBe(owner)
      expect(send).toHaveBeenCalledTimes(before || boundary === 'admission-error' ? 0 : 1)
      if (boundary !== 'admission-error') {
        aborts.abort('prepared', new Error('original stopped'))
      }
      if (before) {
        await vi.waitFor(() => expect(frameDone).toBe(true))
        expect(send).not.toHaveBeenCalled()
        expect(session.dispatchWaiters).toHaveLength(0)
      } else {
        expect(frameDone).toBe(false)
      }
      gate.resolve()
      const resolve = await task
      task = undefined
      await resolve()
      if (before || boundary === 'admission-error') {
        expect(send).not.toHaveBeenCalled()
      } else {
        expect(send).toHaveBeenCalledOnce()
        const waiter = [...session.dispatchWaiters, ...session.retiredDispatchWaiters][0]!
        expect(waiter.clientMessageId).toBe('original')
        expect(journal.submission('original')?.dispatchState).toBe(
          boundary === 'fold-error' ? 'unknown' : 'pending'
        )
        const late = vi.fn()
        const replay = claude.userReplayFrame(waiter.sentUuid, 'same original')
        expect(resolveClaudeReplayTurn(session, replay, late)).toEqual(
          boundary === 'fold-error'
            ? null
            : { clientMessageId: 'original', requestedAt: waiter.requestedAt }
        )
        expect(late).toHaveBeenCalledOnce()
        expect(late.mock.calls[0]?.[0]).toMatchObject({
          clientMessageId: 'original',
          providerIdentity: { uuid: waiter.sentUuid }
        })
      }
      if (boundary === 'late-error') {
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(
            'recording a cancelled prepared input failed',
            expect.objectContaining({ error: failure })
          )
        )
      }
      if (boundary === 'admission-error') {
        expect(journal.submission('original')).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: 'writeFailed' }
        })
      }
      expect(frameDone).toBe(true)
      expect(session.dispatchWaiters).toHaveLength(0)
      expect(session.retiredDispatchWaiters).toHaveLength(0)
      pending!.release?.()
      expect(structuredAgentSessionHandingOver(journal).size).toBe(0)
    } finally {
      gate.resolve()
      await task?.then(async (resolve) => resolve())
      pending?.release?.()
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)
