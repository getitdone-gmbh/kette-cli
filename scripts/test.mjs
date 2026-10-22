// Runs every test/*.test.mjs; npm on Windows runs scripts through cmd.exe, which expands no globs, and Node 20 has no glob support of its own
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../test/', import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
