// Copies the licence of every bundled library into public/licenses/ and writes
// src/libraries.json for the About dialog. Run with: npm run licenses
// (re-run after changing anything in vendor/).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Tolerate a byte-order mark (some Windows editors add one).
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const pkg = readJson(join(root, 'package.json'));
const outDir = join(root, 'public', 'licenses');
mkdirSync(outDir, { recursive: true });

const urls = {
  three: 'https://threejs.org',
  'manifold-3d': 'https://github.com/elalish/manifold',
  fflate: 'https://github.com/101arrowz/fflate',
  lucide: 'https://lucide.dev',
  'opentype.js': 'https://github.com/opentypejs/opentype.js',
};

const libraries = Object.keys(pkg.dependencies).map((name) => {
  const dir = join(root, 'node_modules', name);
  const meta = readJson(join(dir, 'package.json'));
  const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  const fileName = `${name.replace(/[^a-z0-9.-]/gi, '_')}.txt`;
  if (licenseFile) copyFileSync(join(dir, licenseFile), join(outDir, fileName));
  return {
    name,
    version: meta.version,
    license: meta.license,
    url: urls[name] ?? meta.homepage ?? '',
    licenseFile: licenseFile ? `licenses/${fileName}` : null,
  };
});

// Fonts used for embossed text, kept in public/fonts with their licences.
const fonts = [
  ['Roboto (font)', 'OFL-1.1', 'Roboto-LICENSE.txt', 'https://fonts.google.com/specimen/Roboto'],
  ['Roboto Slab (font)', 'Apache-2.0', 'RobotoSlab-LICENSE.txt', 'https://fonts.google.com/specimen/Roboto+Slab'],
  ['Roboto Mono (font)', 'OFL-1.1', 'RobotoMono-LICENSE.txt', 'https://fonts.google.com/specimen/Roboto+Mono'],
];
for (const [name, license, file, url] of fonts) {
  if (!existsSync(join(root, 'public', 'fonts', file))) continue;
  libraries.push({ name, version: '–', license, url, licenseFile: `fonts/${file}` });
}

writeFileSync(join(root, 'src', 'libraries.json'), `${JSON.stringify(libraries, null, 2)}\n`);
console.log(libraries.map((l) => `${l.name} ${l.version} ${l.license}`).join('\n'));
