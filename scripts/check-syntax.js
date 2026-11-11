// Fails CI if any JavaScript file has a syntax error.
const { readdirSync, statSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.js')) files.push(full);
  }
}
['server', 'public', 'scripts', 'test'].forEach((d) => walk(join(__dirname, '..', d)));

let failed = 0;
for (const file of files) {
  try {
    // client.js is an ES module
    const args = file.endsWith('client.js') ? ['--input-type=module', '--check'] : ['--check', file];
    if (file.endsWith('client.js')) execFileSync(process.execPath, args, { input: require('fs').readFileSync(file), stdio: ['pipe', 'pipe', 'pipe'] });
    else execFileSync(process.execPath, args, { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${file}\n${err.stderr}`);
  }
}
console.log(`Checked ${files.length} files, ${failed} failed.`);
process.exit(failed ? 1 : 0);
