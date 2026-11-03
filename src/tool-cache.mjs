import { mkdir, stat, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';

// HOME remains private per chat. Only disposable tool downloads are shared.
// Existing real cache directories are preserved; no running compiler is moved.
export async function sharedToolCache(home, scratch) {
  const root = join(home, 'tool-cache'); await mkdir(root, {recursive: true, mode: 0o700});
  const local = join(scratch, process.platform === 'darwin' ? 'Library/Caches' : '.cache');
  await mkdir(join(scratch, process.platform === 'darwin' ? 'Library' : '.'), {recursive: true, mode: 0o700});
  if (!await stat(local).catch(e => {if(e.code === 'ENOENT')return null;throw e;}))
    await symlink(root, local, process.platform === 'win32' ? 'junction' : 'dir').catch(e => {if(e.code !== 'EEXIST')throw e;});
  return {root: await realpath(root), local};
}
