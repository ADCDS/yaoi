#!/usr/bin/env node
// bin/build-static.js — assemble the static bundle for GitHub Pages.
//
// There is no bundler and no transpiler. The page is ES modules and plain CSS,
// so "building" is copying the client, copying the isomorphic core it imports,
// and writing the one file that tells it which mode it is running in.
//
// Import paths are RELATIVE (`./core/ovh.js`) on purpose: Pages serves a project
// site from a subpath like /yaoi-ovh-inspector/, where an absolute /core/ would 404.
//
// Usage: node bin/build-static.js --out dist

import path from 'node:path';
import { mkdir, copyFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

// Only the modules the browser actually imports. notify/ and store-node.js are
// server-side and must never reach a public bundle.
const CORE_FOR_BROWSER = ['ovh.js', 'watches.js', 'state.js', 'history.js', 'deeplink.js'];

async function main() {
  const outDir = path.resolve(String(arg('out', path.join(ROOT, 'dist'))));
  await mkdir(path.join(outDir, 'core'), { recursive: true });

  for (const f of await readdir(path.join(ROOT, 'public'))) {
    if (f === 'config.js') continue; // generated below, never copied
    await copyFile(path.join(ROOT, 'public', f), path.join(outDir, f));
  }
  for (const f of CORE_FOR_BROWSER) {
    await copyFile(path.join(ROOT, 'core', f), path.join(outDir, 'core', f));
  }

  await writeFile(path.join(outDir, 'config.js'),
    `window.__YAOI = ${JSON.stringify({
      mode: 'static',
      snapshot: './snapshot.json',
      snapshotFull: './snapshot-full.json',
      subsidiary: process.env.OVH_SUBSIDIARY || 'CA',
    })};\n`);

  // Pages would otherwise run the output through Jekyll, which drops files and
  // directories beginning with an underscore.
  await writeFile(path.join(outDir, '.nojekyll'), '');

  const files = (await readdir(outDir)).filter((f) => !f.startsWith('.'));
  console.log(`built ${outDir}`);
  console.log(`  ${files.join(', ')}`);
  console.log(`  core/: ${CORE_FOR_BROWSER.join(', ')}`);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
