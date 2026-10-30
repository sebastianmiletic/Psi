import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'bin', 'scripts', 'test']) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const r = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}
console.log('All JavaScript modules parse successfully.');
