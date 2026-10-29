import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ['browser/toolbox-vendor.js'], outfile: 'public/vendor/toolbox.js', bundle: true, external: ['./vendor/toolbox.js'], format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'linked', logLevel: 'warning', metafile: true });
// Published ESM builds do not all carry their package's license comment.
// Preserve the license files of every package included in this local bundle.
const packages = new Set(Object.keys(result.metafile.inputs).map(input => /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input)?.[1]).filter(Boolean));
for (const name of [...packages].sort()) {
  const directory = path.join(root, 'node_modules', name), info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENSE-MIT', 'CopyrightNotice.txt']) {
    try { license = await readFile(path.join(directory, filename), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error(`Missing bundled license: ${name}`);
  await appendFile(path.join(root, 'public/vendor/toolbox.js.LEGAL.txt'), `\n\n${info.name}@${info.version}\n${license}`);
}
console.log('Built local toolbox comparison, spreadsheet and TanStack Charts modules.');
