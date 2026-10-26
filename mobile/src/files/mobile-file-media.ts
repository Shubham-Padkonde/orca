import { MEDIA_FILE_MIME_TYPES } from '../../../src/shared/media-file-extensions'

export const PDF_MIME_TYPE = 'application/pdf'

export type MobileFileMedia = {
  worktreeId: string
  relativePath: string
  mimeType: string
}

export function mobileFileMedia(worktreeId: string, relativePath?: string): MobileFileMedia | null {
  const mimeType = relativePath ? mobileFileMediaMime(relativePath) : null
  return relativePath && mimeType ? { worktreeId, relativePath, mimeType } : null
}

// PDFs count as media because they share the download-then-device-viewer path, opened by the shell instead of a <video>.
export function mobileFileMediaMime(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  const extension = name.slice(dot).toLowerCase()
  return extension === '.pdf' ? PDF_MIME_TYPE : (MEDIA_FILE_MIME_TYPES[extension] ?? null)
}
