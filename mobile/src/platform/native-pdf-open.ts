import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Platform } from 'react-native'
import { Directory, File as FsFile, Paths } from 'expo-file-system'
import { z } from 'zod'
import { presentPdf } from '../../modules/orca-mobile-web-shell/src'
import { PDF_MIME_TYPE } from '../files/mobile-file-media'
import { downloadMobileFileMedia, type MobileMediaSink } from '../files/mobile-file-media-download'
import { pdfOpenParamsSchema } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { useHostClient } from '../transport/host-client-hooks'
import type { RpcClient } from '../transport/rpc-client'

const noViewerErrorSchema = z.object({ code: z.literal('ERR_NO_PDF_VIEWER') })

function pdfFileSink(file: FsFile): MobileMediaSink {
  file.create({ overwrite: true })
  const handle = file.open()
  return {
    append: (bytes) => handle.writeBytes(bytes),
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

// One folder for every open: an external viewer may still be reading the last PDF, so it is cleared only when the next one starts.
export function createNativePdfOpener(readClient: () => RpcClient | null) {
  let current: AbortController | null = null
  return {
    serve: async (params: unknown): Promise<Record<string, never>> => {
      const { worktreeId, relativePath, executionHost } = pdfOpenParamsSchema.parse(params)
      const client = readClient()
      if (!client) {
        throw new Error('no desktop connection to download the PDF from')
      }
      current?.abort()
      const controller = new AbortController()
      current = controller
      const folder = new Directory(Paths.cache, 'orca-pdf')
      if (folder.exists) {
        folder.delete()
      }
      folder.create()
      const name = relativePath.split(/[/\\]/).pop() ?? 'document.pdf'
      const uri = await downloadMobileFileMedia(
        executionHost ? scopeRpcClientToExecutionHost(client, executionHost) : client,
        { worktreeId, relativePath, mimeType: PDF_MIME_TYPE },
        pdfFileSink(new FsFile(folder, name)),
        controller.signal,
        () => {}
      )
      if (controller.signal.aborted) {
        throw new Error('a newer PDF open replaced this one')
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
    },
    dispose: () => current?.abort()
  }
}

// A replaced or closed page must not have a viewer pop up over whatever screen comes next.
export function useNativePdfOpener(
  hostId: string,
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  const { client } = useHostClient(hostId)
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  const opener = useMemo(() => createNativePdfOpener(() => clientRef.current), [sessionId])
  useEffect(() => () => opener.dispose(), [opener])
  return opener.serve
}
