import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { Platform } from 'react-native'
import { Directory, File as FsFile, Paths } from 'expo-file-system'
import { useFocusEffect } from 'expo-router'
import { z } from 'zod'
import { presentPdf } from '../../modules/orca-mobile-web-shell/src'
import { PDF_MIME_TYPE } from '../files/mobile-file-media'
import { downloadMobileFileMedia, type MobileMediaSink } from '../files/mobile-file-media-download'
import {
  pdfViewParamsSchema,
  type BridgePdfOpenParams
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { useHostClient } from '../transport/host-client-hooks'
import type { RpcClient } from '../transport/rpc-client'

const noViewerErrorSchema = z.object({ code: z.literal('ERR_NO_PDF_VIEWER') })

function pdfFileSink(file: FsFile): MobileMediaSink {
  file.create({ overwrite: true })
  const handle = file.open()
  return {
    // Expo's JSI rejects the buffer polyfill's Uint8Array subclass, so pass a plain view.
    append: (bytes) =>
      handle.writeBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    finish: () => {
      handle.close()
      return Platform.OS === 'android' ? file.contentUri : file.uri
    },
    dispose: () => {
      handle.close()
      try {
        file.delete()
      } catch {
        // A newer open already cleared the folder.
      }
    }
  }
}

// An external viewer may still read the last PDF, so earlier ones are cleared only when the next starts.
// Each open gets its own folder so an aborted download's cleanup cannot delete its replacement.
export function createNativePdfViewer(readClient: () => RpcClient | null) {
  let current: AbortController | null = null
  const open = async ({
    worktreeId,
    relativePath,
    executionHost
  }: BridgePdfOpenParams): Promise<Record<string, never>> => {
    const client = readClient()
    if (!client) {
      throw new Error('no desktop connection to download the PDF from')
    }
    current?.abort()
    const controller = new AbortController()
    current = controller
    const root = new Directory(Paths.cache, 'orca-pdf')
    if (root.exists) {
      root.delete()
    }
    const folder = new Directory(root, `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    folder.create({ intermediates: true })
    const name = relativePath.split(/[/\\]/).pop() ?? 'document.pdf'
    const uri = await downloadMobileFileMedia(
      executionHost ? scopeRpcClientToExecutionHost(client, executionHost) : client,
      { worktreeId, relativePath, mimeType: PDF_MIME_TYPE },
      pdfFileSink(new FsFile(folder, name)),
      controller.signal,
      () => {}
    )
    if (controller.signal.aborted) {
      throw new Error('the PDF open was cancelled')
    }
    try {
      await presentPdf(uri)
    } catch (error) {
      if (noViewerErrorSchema.safeParse(error).success) {
        throw new BridgeNativeVerbRefusedError('native_pdf_no_viewer', 'no app can open PDFs')
      }
      throw error
    }
    return {}
  }
  return {
    serve: async (params: unknown): Promise<Record<string, never>> => {
      const request = pdfViewParamsSchema.parse(params)
      if (request.action === 'open') {
        return open(request)
      }
      current?.abort()
      return {}
    },
    dispose: () => current?.abort()
  }
}

// A replaced, closed or covered shell must not have a viewer pop up over whatever screen comes next.
export function useNativePdfViewer(
  hostId: string,
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  const { client } = useHostClient(hostId)
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  const viewer = useMemo(() => createNativePdfViewer(() => clientRef.current), [sessionId])
  useFocusEffect(useCallback(() => () => viewer.dispose(), [viewer]))
  return viewer.serve
}
