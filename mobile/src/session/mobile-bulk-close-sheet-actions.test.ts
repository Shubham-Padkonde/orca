import { describe, expect, it, vi } from 'vitest'
import { createBulkCloseSheetActions } from './mobile-bulk-close-sheet-actions'
import type { MobileSessionTab } from './mobile-session-route-types'

const terminal = (id: string): MobileSessionTab => ({
  type: 'terminal',
  id,
  title: id,
  terminal: `term-${id}`,
  isActive: false
})

function pressCloseOthers(confirmed: boolean) {
  let answer: (confirmed: boolean) => void = () => {}
  const closeSessionTab = vi.fn((_tab: MobileSessionTab) => Promise.resolve())
  const tabs = [terminal('a'), terminal('b'), terminal('c')]
  const [action] = createBulkCloseSheetActions({
    sessionTabsRef: { current: tabs },
    markdownDocs: new Map(),
    activeSessionTabIdRef: { current: 'a' },
    switchSessionTab: vi.fn(),
    closeSessionTab,
    confirmBulkClose: () =>
      new Promise((resolve) => {
        answer = resolve
      })
  })('a')
  action.onPress()
  expect(closeSessionTab).not.toHaveBeenCalled()
  answer(confirmed)
  return closeSessionTab
}

describe('Close Other Tabs', () => {
  it('closes the other tabs only after the user confirms', async () => {
    const closeSessionTab = pressCloseOthers(true)
    await vi.waitFor(() => expect(closeSessionTab).toHaveBeenCalledTimes(2))
    expect(closeSessionTab.mock.calls.map(([tab]) => tab.id)).toEqual(['b', 'c'])
  })

  it('keeps every tab when the user cancels', async () => {
    const closeSessionTab = pressCloseOthers(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closeSessionTab).not.toHaveBeenCalled()
  })
})
