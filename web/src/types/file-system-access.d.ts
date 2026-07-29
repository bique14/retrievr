/**
 * `lib.dom.d.ts` in this TypeScript version declares `FileSystemFileHandle`
 * and `FileSystemWritableFileStream`, but not the `Window.showSaveFilePicker`/
 * `Window.showDirectoryPicker` entry points used to obtain a handle.
 * Chrome-only (see blueprint-1.0.md section 19); this file adds just the
 * missing surface.
 */
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  excludeAcceptAllOption?: boolean;
}

interface DirectoryPickerOptions {
  mode?: "read" | "readwrite";
}

interface Window {
  showSaveFilePicker(
    options?: SaveFilePickerOptions,
  ): Promise<FileSystemFileHandle>;
  showDirectoryPicker(
    options?: DirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
}
