import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { usePdfOpener } from '../platform/pdf-opener'
import { PdfNoViewerError } from '../platform/pdf-opener-contract'
import type { MobileFileMedia } from './mobile-file-media'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'

type State =
  | { status: 'opening' }
  | { status: 'opened' }
  | { status: 'failed'; message: string; retryable: boolean }

// The shell downloads the PDF and shows it in Quick Look (iOS) or the system viewer (Android).
export function MobilePdfPreview({ media }: { media: MobileFileMedia }) {
  const opener = usePdfOpener()
  const [state, setState] = useState<State>({ status: 'opening' })
  const [attempt, setAttempt] = useState(0)
  const { worktreeId, relativePath, mimeType } = media
  useEffect(() => {
    if (!opener) {
      return
    }
    let pending = true
    setState({ status: 'opening' })
    opener.open({ worktreeId, relativePath, mimeType }).then(
      () => {
        if (pending) {
          pending = false
          setState({ status: 'opened' })
        }
      },
      (error: unknown) => {
        if (pending) {
          pending = false
          setState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unable to open this PDF',
            retryable: !(error instanceof PdfNoViewerError)
          })
        }
      }
    )
    return () => {
      if (pending) {
        pending = false
        opener.cancel()
      }
    }
  }, [opener, worktreeId, relativePath, mimeType, attempt])
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
      <Pressable style={styles.openButton} onPress={reopen} accessibilityRole="button">
        <Text style={styles.openButtonText}>Open PDF</Text>
      </Pressable>
    </View>
  )
}
