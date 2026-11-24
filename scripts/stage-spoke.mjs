#!/usr/bin/env node
// Stage the one Scribe Windows download: the tree HelmianSpoke.iss packs.
//   spoke/spoke-installer/stage/
//     node.exe                         (added by the release workflow)
//     bin/hands-spoke.mjs
//     src/hands/*.mjs                  (minus root-grant-signer.mjs: the
//                                       Guard-side issuer never ships to a PC)
//     src/core/agent-os.mjs            (bin/hands-spoke.mjs imports it)
//     templates/agent-os/**            (agent-os profile sync templates)
//     hands-mcp/src/shared/protocol.mjs
//     package.json, LICENSE, PRIVACY.md, install-pair.mjs
// The spoke itself defaults to the Hands hub and the Executive Guard key
// (DEFAULT_HANDS_URL in pc-spoke.mjs, GUARD_KEYS_URL in install-pair.mjs);
// the hub carries results to the Scribe memory server (SCRIBE_MCP_URL).
import { cpSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPOKE = join(ROOT, 'spoke');
const STAGE = resolve(process.argv[2] || join(SPOKE, 'spoke-installer', 'stage'));
const EXCLUDE_FROM_PC = new Set(['root-grant-signer.mjs']);

rmSync(join(STAGE, 'bin'), { recursive: true, force: true });
rmSync(join(STAGE, 'src'), { recursive: true, force: true });
rmSync(join(STAGE, 'templates'), { recursive: true, force: true });
rmSync(join(STAGE, 'hands-mcp'), { recursive: true, force: true });
for (const d of ['bin', 'src/hands', 'src/core', 'hands-mcp/src/shared']) mkdirSync(join(STAGE, d), { recursive: true });

copyFileSync(join(SPOKE, 'bin', 'hands-spoke.mjs'), join(STAGE, 'bin', 'hands-spoke.mjs'));
for (const f of readdirSync(join(SPOKE, 'src', 'hands'))) {
  if (f.endsWith('.mjs') && !EXCLUDE_FROM_PC.has(f)) copyFileSync(join(SPOKE, 'src', 'hands', f), join(STAGE, 'src', 'hands', f));
}
copyFileSync(join(SPOKE, 'src', 'core', 'agent-os.mjs'), join(STAGE, 'src', 'core', 'agent-os.mjs'));
cpSync(join(SPOKE, 'templates', 'agent-os'), join(STAGE, 'templates', 'agent-os'), { recursive: true });
copyFileSync(join(SPOKE, 'hands-mcp', 'src', 'shared', 'protocol.mjs'), join(STAGE, 'hands-mcp', 'src', 'shared', 'protocol.mjs'));
copyFileSync(join(SPOKE, 'package.json'), join(STAGE, 'package.json'));
copyFileSync(join(ROOT, 'LICENSE'), join(STAGE, 'LICENSE'));
copyFileSync(join(ROOT, 'PRIVACY.md'), join(STAGE, 'PRIVACY.md'));
copyFileSync(join(SPOKE, 'spoke-installer', 'install-pair.mjs'), join(STAGE, 'install-pair.mjs'));
console.log(`staged spoke tree at ${STAGE}`);
