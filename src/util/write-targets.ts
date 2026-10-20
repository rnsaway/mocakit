import { lstat } from 'node:fs/promises';

/**
 * Throws unless `path` is absent or a regular file (not a link, folder or device): `writeFile`
 * follows links, and a dangling link would create its target. Returns whether the file exists.
 */
export async function refuseNonRegularFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (info !== null && !info.isFile()) throw new Error(`refusing to write into ${path}: it is not a regular file`);
  return info !== null;
}

/**
 * Throws unless `path` is absent or a real folder (a link or junction to a folder is refused).
 * Returns whether the folder exists.
 */
export async function refuseNonFolder(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (info !== null && !info.isDirectory()) throw new Error(`refusing to write into ${path}: it is not a folder`);
  return info !== null;
}
