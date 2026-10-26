import type { MobileFileMedia } from '../files/mobile-file-media'

export type PdfOpener = (media: MobileFileMedia) => Promise<void>

// Retrying cannot help until the user installs a PDF app, so the preview offers no Retry.
export class PdfNoViewerError extends Error {
  constructor() {
    super('No app on this phone can open PDFs')
    this.name = 'PdfNoViewerError'
  }
}
