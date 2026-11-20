import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { storageLimits, storageLimit } from '../persistence/storage-limits.js';

/** Admission control for the MCP upload directory; never deletes source images. */
export async function assertUploadBudget(root: string) {
  const limits = storageLimits();
  const directories = [root];
  let bytes = 0;
  let files = 0;
  let entries = 0;
  for (const directory of directories) {
    for await (const entry of await opendir(directory)) {
      // Bound traversal as well: empty directories must not cause an unlimited scan.
      if (++entries > limits.uploadFiles * 4)
        throw storageLimit('upload_entries', limits.uploadFiles * 4, entries);
      const info = await lstat(join(directory, entry.name)).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) directories.push(join(directory, entry.name));
      else if (info.isFile()) {
        bytes += info.size;
        files++;
        if (bytes > limits.uploadBytes)
          throw storageLimit('upload_bytes', limits.uploadBytes, bytes);
        if (files > limits.uploadFiles)
          throw storageLimit('upload_files', limits.uploadFiles, files);
      }
    }
  }
}
