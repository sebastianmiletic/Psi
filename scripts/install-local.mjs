import { mkdir, lstat, symlink, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = join(homedir(), '.local', 'bin'); const destination = join(directory, 'psi');
const target = fileURLToPath(new URL('../bin/psi.mjs', import.meta.url));
await mkdir(directory, { recursive: true });
const existing = await lstat(destination).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
if (existing) {
  if (!existing.isSymbolicLink() || await readlink(destination) !== target) throw new Error(`${destination} already exists. Existing launcher was left untouched.`);
} else await symlink(target, destination);
console.log(`Installed ${destination} → ${target}`);
if (!process.env.PATH.split(':').includes(directory)) console.log(`Add ${directory} to PATH to use psi from any directory.`);
