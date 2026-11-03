// Versioned, checksummed Brotli segments plus a small fsynced JSONL tail.
// Rotation is recoverable at every rename; a raw segment always wins over its archive.
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readdir, stat, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createBrotliCompress, createBrotliDecompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { privateDir, withLock, durableJournalSize, replaceFile } from './storage.mjs';

export const SEGMENT_BYTES = 256 * 1024;
const pattern = /^(\d{12})-(\d+)\.(jsonl|psi)$/;
const MAGIC=Buffer.from([0x50,0x53,0x49,1]),HEADER_BYTES=44;
const exists = path => stat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
export async function syncDirectory(dir) {
  let h;
  try { h = await open(dir, 'r'); await h.sync(); }
  catch (e) { if (!['EINVAL', 'EPERM', 'EISDIR', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e; }
  finally { await h?.close(); }
}
async function segments(dir) {
  const root = join(dir, 'history'), found = new Map();
  for (const name of await readdir(root).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    const m = name.match(pattern); if (!m) continue;
    const key = m[1], previous = found.get(key);
    if(!Number.isSafeInteger(Number(m[2]))||Number(m[2])<1)throw new Error('Invalid session segment length.');
    if (previous && previous.bytes !== Number(m[2])) throw new Error('Conflicting session history segments.');
    if (!previous || m[3]==='jsonl') found.set(key, { key, bytes: Number(m[2]), path: join(root, name), compressed: m[3]==='psi' });
  }
  const ordered=[...found.values()].sort((a,b)=>a.key.localeCompare(b.key));
  for(const [index,s] of ordered.entries())if(Number(s.key)!==index+1)throw new Error('Missing session history segment. Restore it from a backup.');
  return ordered;
}
async function snapshot(dir) {
  const archived = await segments(dir), tail = await exists(join(dir, 'events.jsonl'));
  let size = archived.reduce((sum, s) => sum + s.bytes, 0), mtimeMs = tail?.mtimeMs || 0;
  for (const s of archived) { const info = await stat(s.path);if(!s.compressed&&info.size!==s.bytes)throw new Error('Session history segment length changed. Original retained.'); mtimeMs = Math.max(mtimeMs, info.mtimeMs); }
  return { archived, tail, size: size + (tail?.size || 0), mtimeMs, ino: archived.length ? `segments:${archived.at(-1).key}:${tail?.ino || 0}` : tail?.ino || 0 };
}
export async function journalInfo(dir) {
  return withLock(join(dir, 'storage.lock'), () => snapshot(dir));
}
async function digest(stream) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { hash: hash.digest('hex'), bytes };
}
export async function* readCompressed(path, expectedBytes) {
  const handle=await open(path,'r'),header=Buffer.alloc(HEADER_BYTES);
  try { const {bytesRead}=await handle.read(header,0,HEADER_BYTES,0);
    if(bytesRead!==HEADER_BYTES||!header.subarray(0,4).equals(MAGIC))throw new Error('Invalid or unsupported Psi storage header.');
  } finally { await handle.close(); }
  const expected=Number(header.readBigUInt64LE(4));
  if(!Number.isSafeInteger(expected)||expectedBytes!==undefined&&expected!==expectedBytes)throw new Error('Invalid Psi storage length.');
  const input=createReadStream(path,{start:HEADER_BYTES}),stream=input.pipe(createBrotliDecompress()),hash=createHash('sha256');let bytes=0;
  input.on('error',e=>stream.destroy(e));
  try {
    for await(const chunk of stream){bytes+=chunk.length;if(bytes>expected)throw new Error('Psi storage length check failed.');hash.update(chunk);yield chunk;}
    if(bytes!==expected||!hash.digest().equals(header.subarray(12)))throw new Error('Psi storage checksum check failed.');
  } finally {stream.destroy();input.destroy();}
}
export async function compressFile(path, {remove = true} = {}) {
  const info = await stat(path), target = path.replace(/\.jsonl$/, '') + '.psi', tmp = target + '.' + randomUUID() + '.tmp';
  try {
    // Callers own the storage lock, so these are abandoned stages from a crash.
    const prefix=target.split(/[/\\]/).at(-1)+'.';
    for(const name of await readdir(dirname(path)))if(name.startsWith(prefix)&&/\.[0-9a-f-]{36}\.tmp$/.test(name))await unlink(join(dirname(path),name));
    const before = await digest(createReadStream(path));
    const header=Buffer.alloc(HEADER_BYTES);MAGIC.copy(header);header.writeBigUInt64LE(BigInt(before.bytes),4);Buffer.from(before.hash,'hex').copy(header,12);
    await writeFile(tmp,header,{flag:'wx',mode:0o600});
    await pipeline(createReadStream(path), createBrotliCompress({params:{[constants.BROTLI_PARAM_QUALITY]:6,[constants.BROTLI_PARAM_LGWIN]:22}}), createWriteStream(tmp, { flags: 'a', mode: 0o600 }));
    const after = await digest(readCompressed(tmp,before.bytes));
    if (before.bytes !== after.bytes || before.hash !== after.hash) throw new Error('Compressed storage verification failed. Original retained.');
    // Refuse to replace a file that changed during compression.
    const current = await stat(path);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error('Storage changed during compression. Original retained.');
    await utimes(tmp, info.atime, info.mtime);
    const h = await open(tmp, 'r+'); try { await h.sync(); } finally { await h.close(); }
    await replaceFile(tmp, target); await syncDirectory(dirname(path));
    if (remove) { await unlink(path); await syncDirectory(dirname(path)); }
    return { before: info.size, after: (await stat(target)).size };
  } finally { await unlink(tmp).catch(() => {}); }
}
export async function compactJournal(dir, {force = false, repair = false} = {}) {
  return withLock(join(dir, 'storage.lock'), async () => {
    if (repair) await durableJournalSize(join(dir, 'events.jsonl'));
    const old = await segments(dir);
    for (const s of old) if (!s.compressed) await compressFile(s.path);
    const tail = join(dir, 'events.jsonl'), info = await exists(tail);
    if (info?.size >= (force ? 16 * 1024 : SEGMENT_BYTES)) {
      // Only complete durable lines are sealed; a torn tail is repaired on load.
      const h = await open(tail, 'r'), last = Buffer.alloc(1);
      try { await h.read(last, 0, 1, info.size - 1); } finally { await h.close(); }
      if (last[0] !== 10) throw new Error('Incomplete live journal; reopen to recover before compacting.');
      const root = join(dir, 'history'); await privateDir(root);
      const key = String(Number(old.at(-1)?.key || 0) + 1).padStart(12, '0');
      const raw = join(root, `${key}-${info.size}.jsonl`);
      await rename(tail, raw); await syncDirectory(root); await syncDirectory(dir);
      await compressFile(raw);
    }
    return snapshot(dir);
  });
}
// Logical byte offsets remain stable across compression, rotation and partial reads.
// Holding this lock pins filenames; appenders can still fsync the bounded live tail.
export async function* journalLines(dir, {offset = 0} = {}) {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let acquired, acquisitionError;
  const started = new Promise(resolve => {
    acquired = withLock(join(dir, 'storage.lock'), async () => { resolve(); await ready; }).catch(e => { acquisitionError = e; resolve(); });
  });
  await started;
  if (acquisitionError) throw acquisitionError;
  try {
    const view = await snapshot(dir), files = [...view.archived];
    if (view.tail?.size) files.push({path: join(dir, 'events.jsonl'), bytes: view.tail.size, compressed: false});
    let base = 0, consumed = offset, pending = '', decoder = new StringDecoder('utf8');
    for (const file of files) {
      if (base + file.bytes <= offset) { base += file.bytes; continue; }
      const skip = Math.max(0, offset - base);
      const stream = file.compressed ? readCompressed(file.path,file.bytes) : createReadStream(file.path,{start:skip,end:file.bytes-1});
      let skipped = file.compressed ? skip : 0;
      try {
        for await (let chunk of stream) {
          if (skipped) { const n = Math.min(skipped, chunk.length); skipped -= n; chunk = chunk.subarray(n); }
          pending += decoder.write(chunk); let at;
          while ((at = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, at); pending = pending.slice(at + 1); consumed += Buffer.byteLength(line + '\n');
            yield {line, offset: consumed};
          }
        }
      } finally { if(file.compressed)await stream.return();else stream.destroy(); }
      base += file.bytes;
    }
    // Deliberately ignore an unfinished final line, without mutating a reader's files.
  } finally { release(); await acquired; }
}
