import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['server.mjs'];
for (const folder of ['lib', 'public', 'scripts']) for (const name of await readdir(folder)) if (/\.(mjs|js)$/.test(name)) files.push(`${folder}/${name}`);
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1); }
console.log(`Syntax checked ${files.length} modules.`);
