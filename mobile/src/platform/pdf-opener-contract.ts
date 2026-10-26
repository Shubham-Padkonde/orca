// cancel stops a download the user walked away from, so no viewer opens over the next screen.
export type PdfOpener = {
  open: (file: { worktreeId: string; relativePath: string }) => Promise<void>
  cancel: () => void
}

// Retrying cannot help until the user installs a PDF app, so the preview offers no Retry.
export class PdfNoViewerError extends Error {
  constructor() {
    super('No app on this phone can open PDFs')
    this.name = 'PdfNoViewerError'
  }
}
