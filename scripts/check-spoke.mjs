#!/usr/bin/env node
// `node --check` every Spoke and Hands hub .mjs file (node_modules excluded).
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['spoke/bin', 'spoke/src', 'spoke/spoke-installer', 'spoke/hands-mcp/src', 'spoke/hands-mcp/test', 'spoke/test', 'scripts'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'stage' || name === 'output') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.mjs')) files.push(full);
  }
};
for (const d of DIRS) walk(join(ROOT, d));
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed += 1; console.error(`FAIL ${relative(ROOT, f)}\n${r.stderr}`); }
}
console.log(`node --check: ${files.length - failed}/${files.length} ok`);
process.exit(failed ? 1 : 0);
