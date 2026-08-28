/* ============================================================================
 * Ambient OPFS augmentation
 * ----------------------------------------------------------------------------
 * TypeScript's lib.webworker.d.ts already declares FileSystemDirectoryHandle,
 * FileSystemFileHandle, FileSystemSyncAccessHandle, StorageManager.getDirectory
 * and the Web Locks API — so the engine uses those directly. What the current
 * lib omits is the ASYNC ITERATION surface of a directory handle (keys /
 * values / entries and the async iterator), which OpfsVfs.list needs to
 * enumerate a directory. This file adds exactly those, merging into the
 * existing interface rather than redeclaring it, so no `any` leaks into the
 * engine's public surface.
 * ========================================================================= */

interface FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
}
