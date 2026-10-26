import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { usePdfOpener } from '../platform/pdf-opener'
import { PdfNoViewerError } from '../platform/pdf-opener-contract'
import type { MobileFileMedia } from './mobile-file-media'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { MobileLoadErrorState, MobileStateButton } from '../components/MobileLoadErrorState'

type State =
  | { status: 'opening' }
  | { status: 'idle' }
  | { status: 'failed'; message: string; retryable: boolean }

// The shell downloads the PDF and shows it in Quick Look (iOS) or the system viewer (Android).
export function MobilePdfPreview({ media }: { media: MobileFileMedia }) {
  const opener = usePdfOpener()
  const [state, setState] = useState<State>({ status: 'opening' })
  const [attempt, setAttempt] = useState(0)
  const stopPending = useRef<(() => void) | null>(null)
  const { worktreeId, relativePath } = media
  useEffect(() => {
    if (!opener) {
      return
    }
    let pending = true
    const settle = (next: State) => {
      if (pending) {
        pending = false
        setState(next)
      }
    }
    const stop = () => {
      if (pending) {
        opener.cancel()
      }
      settle({ status: 'idle' })
    }
    stopPending.current = stop
    setState({ status: 'opening' })
    opener.open({ worktreeId, relativePath }).then(
      () => settle({ status: 'idle' }),
      (error: unknown) =>
        settle({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Unable to open this PDF',
          retryable: !(error instanceof PdfNoViewerError)
        })
    )
    return stop
  }, [opener, worktreeId, relativePath, attempt])
  // Hidden stack screens stay mounted, so leaving one must stop its open too.
  useFocusEffect(useCallback(() => () => stopPending.current?.(), []))
  const reopen = () => setAttempt((count) => count + 1)
  if (!opener) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Update Orca Mobile to open PDFs</Text>
      </View>
    )
  }
  if (state.status === 'failed') {
    return (
      <MobileLoadErrorState message={state.message} onRetry={state.retryable ? reopen : null} />
    )
  }
  if (state.status === 'opening') {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.stateText}>Opening PDF...</Text>
      </View>
    )
  }
  return (
    <View style={styles.state}>
      <MobileStateButton label="Open PDF" onPress={reopen} />
    </View>
  )
}
