// Commit the generated assets so ordinary Tauri builds remain static/offline.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'frontend/vendor');
const files = new Map();
const packages = new Set(['node_modules/katex']);

for (const [entry, name] of [['markdown', 'markdown-libs'], ['mermaid', 'mermaid']]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`scripts/${entry}-vendor-entry.mjs`],
    outfile: `${name}.js`,
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    legalComments: 'external',
    metafile: true,
    write: false,
  });
  for (const output of result.outputFiles) files.set(path.basename(output.path), output.contents);
  for (const input of Object.keys(result.metafile.inputs)) {
    // Include the actual installed package, including nested versions used by
    // Mermaid. Their versions and license notices can differ from root copies.
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
}

// Only WOFF2 is needed by the supported Chromium/WebView2 runtime.
const css = await readFile(path.join(root, 'node_modules/katex/dist/katex.min.css'), 'utf8');
files.set('katex.css', Buffer.from(css.replace(/src:[^;]+;/g, declaration => {
  const woff2 = declaration.match(/url\([^)]+\.woff2\)\s*format\([^)]+\)/);
  return woff2 ? `src:${woff2[0]};` : declaration;
})));
for (const name of await readdir(path.join(root, 'node_modules/katex/dist/fonts'))) {
  if (name.endsWith('.woff2')) files.set(`fonts/${name}`, await readFile(path.join(root, 'node_modules/katex/dist/fonts', name)));
}

let licenses = 'Third-party libraries bundled for ContextKey Markdown rendering.\n';
const versions = {};
for (const packagePath of [...packages].sort()) {
  const directory = path.join(root, packagePath);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  versions[packagePath.slice('node_modules/'.length)] = pkg.version;
  licenses += `\n===== ${pkg.name} ${pkg.version} (${pkg.license || 'see license'}) =====\n`;
  for (const filename of (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)).sort()) {
    licenses += await readFile(path.join(directory, filename), 'utf8') + '\n';
  }
}
files.set('THIRD-PARTY-LICENSES.txt', Buffer.from(licenses));
files.set('manifest.json', Buffer.from(JSON.stringify({
  packages: versions,
  files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => [name, {
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }])),
}, null, 2) + '\n'));

if (process.argv.includes('--check')) {
  for (const [name, content] of files) {
    const existing = await readFile(path.join(destination, name));
    if (!Buffer.from(content).equals(existing)) throw new Error(`Stale vendor asset: ${name}. Run npm run build:vendor.`);
  }
  console.log('Vendored Markdown assets match the pinned dependencies.');
} else {
  await rm(destination, { recursive: true, force: true });
  for (const [name, content] of files) {
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await writeFile(path.join(destination, name), content);
  }
  console.log(`Wrote ${files.size} vendor assets (${([...files.values()].reduce((total, content) => total + content.length, 0) / 1048576).toFixed(2)} MiB).`);
}
