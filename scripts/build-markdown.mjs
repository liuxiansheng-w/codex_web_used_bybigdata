import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await build({ absWorkingDir: root, entryPoints: { document: 'browser/markdown-document.js', mermaid: 'browser/markdown-mermaid.js' }, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, outdir: 'public/vendor/markdown', chunkNames: 'chunk-[hash]', legalComments: 'linked', logLevel: 'warning' });
console.log('Built local Markdown and Mermaid browser modules.');
