/**
 * Guards the dependency budget from PLAN.md §3: exactly one runtime dependency.
 * Build-time tooling lives in devDependencies and never enters the packaged app.
 */
import { readFileSync } from 'node:fs';

const ALLOWED_RUNTIME = ['pg'];

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dependencies = pkg.dependencies ?? {};

const declared = Object.keys(dependencies).sort();
const unexpected = declared.filter((name) => !ALLOWED_RUNTIME.includes(name));
const missing = ALLOWED_RUNTIME.filter((name) => !declared.includes(name));

let failed = false;

if (unexpected.length > 0) {
  console.error(`unexpected runtime dependencies: ${unexpected.join(', ')}`);
  failed = true;
}

if (missing.length > 0) {
  console.error(`missing runtime dependencies: ${missing.join(', ')}`);
  failed = true;
}

for (const [name, range] of Object.entries(dependencies)) {
  if (!/^\d+\.\d+\.\d+$/.test(String(range))) {
    console.error(`"${name}" must be pinned exactly, got "${range}"`);
    failed = true;
  }
}

if (failed) {
  console.error(`allowed runtime dependencies: ${ALLOWED_RUNTIME.join(', ')}`);
  process.exit(1);
}

console.log(`runtime dependency budget OK: ${declared.join(', ')} (exact pin)`);
