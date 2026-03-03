#!/usr/bin/env node
/**
 * Validation: run the politics proposer and assert that either
 * proposals_written_proxy > 0 or at least one block has top proxyConf >= 0.88.
 * Exit 0 if condition met, 1 otherwise (for CI / definition of done).
 *
 * Usage: node scripts/pmci-assert-proxy-proposals.mjs
 * Env: DATABASE_URL (passed through to proposer)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const proposerScript = path.join(repoRoot, 'scripts', 'pmci-propose-links-politics.mjs');

function main() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [proposerScript], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, reason: `proposer exited ${code}` });
        return;
      }
      const proxyMatch = stdout.match(/proposals_written_proxy=(\d+)/);
      const written = proxyMatch ? Number(proxyMatch[1]) : 0;
      const topConfMatch = stdout.match(/proxyConf=[\d.]+/g);
      const hasHighConf = topConfMatch && topConfMatch.some((m) => parseFloat(m.replace('proxyConf=', '')) >= 0.88);
      if (written > 0) {
        resolve({ ok: true, reason: `proposals_written_proxy=${written}` });
        return;
      }
      if (hasHighConf) {
        resolve({ ok: true, reason: 'at least one block has top proxyConf >= 0.88' });
        return;
      }
      resolve({ ok: false, reason: 'proposals_written_proxy=0 and no block with top proxyConf >= 0.88' });
    });
  }).then((result) => {
    if (result.ok) {
      console.log('pmci:assert-proxy OK:', result.reason);
      process.exit(0);
    } else {
      console.error('pmci:assert-proxy FAIL:', result.reason);
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error('pmci:assert-proxy ERROR:', err.message);
  process.exit(1);
});
