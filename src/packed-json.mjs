import { readFile, writeFile, unlink, open, stat, readdir } from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, readJSON, withLock, replaceFile } from './storage.mjs';
import { syncDirectory } from './journal.mjs';
const zip = promisify(gzip), unzip = promisify(gunzip);
export async function readPackedJSON(path, fallback) {
  try { return JSON.parse((await unzip(await readFile(path + '.gz'))).toString('utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read ${path}.gz: ${e.message}`); return readJSON(path, fallback); }
}
export async function writePackedJSON(path, value) {
  await privateDir(dirname(path)); const target = path + '.gz', tmp = target + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, await zip(JSON.stringify(value), {level: 9}), {mode: 0o600});
    const h = await open(tmp, 'r+'); try { await h.sync(); } finally { await h.close(); }
    await replaceFile(tmp, target); await syncDirectory(dirname(path));
    await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
  } finally { await unlink(tmp).catch(() => {}); }
}
// Rebuildable HTTP cache only. Artifacts and saved session evidence are never pruned.
export async function pruneWebCache(home, {now = Date.now(), maxBytes = 16 * 1024 * 1024, maxAge = 300000} = {}) {
  const dir = join(home, 'web-cache');
  return withLock(join(dir, 'cache.lock'), async () => {
    const files = [];
    for (const name of await readdir(dir)) if (/^[a-f0-9]{24}\.json(?:\.gz)?$/.test(name)) {
      const path = join(dir, name), info = await stat(path).catch(() => null); if (info) files.push({path, ...info});
    }
    files.sort((a,b) => b.mtimeMs - a.mtimeMs); let kept = 0;
    for (const file of files) {
      if (now - file.mtimeMs > maxAge || kept + file.size > maxBytes) await unlink(file.path).catch(e => { if (e.code !== 'ENOENT') throw e; });
      else kept += file.size;
    }
    return kept;
  });
}
