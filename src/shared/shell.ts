import type { ImageArtifactSaveRequest, ImageArtifactSaveResult } from './image-artifact'
import type { LocalFileOpenResult } from './local-file-link'

/**
 * What the renderer may ask the surrounding operating system for: the clipboard, the default
 * browser, the file manager, and a Save dialog. Every member here leaves the application, so main
 * - not the renderer - decides whether each one is allowed and says why not.
 */
export interface ShellApi {
  copyText(text: string): void
  openExternal(url: string): Promise<void>
  /** Selects a file in the OS file manager; never opens or executes it. */
  showItemInFolder(path: string): Promise<void>
  /**
   * Opens a local artifact - an image, a document, a media file - with the application the OS
   * associates with it. Main decides whether the path may be opened at all and says why not.
   */
  openLocalFile(path: string): Promise<LocalFileOpenResult>
  /**
   * Writes one image out of the transcript to a file the user picks. The bytes travel from the
   * transcript rather than from any path the agent mentioned, which is what makes a generated
   * image the reader's to keep at all (`shared/image-artifact.ts`).
   */
  saveImage(request: ImageArtifactSaveRequest): Promise<ImageArtifactSaveResult>
  readClipboardText(): string
}
