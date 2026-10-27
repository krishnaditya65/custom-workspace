// Sequences the correctness check and both benchmarks into one pass, for a
// single run you intend to record (see docs/BENCHMARKS.md "Recording a
// run"). Does NOT start or stop apps/api, apps/sync, or backing infra -
// point SYNC_URL/API_URL/DATABASE_URL/etc at whatever's already running
// (see docs/BENCHMARKS.md "Prerequisites"). Invoked as `pnpm bench` from the
// repo root, or `pnpm --filter @workspace/bench run bench:all` from here.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

// Runs `node <script>` with cwd=bench/ (so the scripts' relative ./lib
// imports resolve regardless of where run-all.mjs itself was invoked from),
// streaming output live and also capturing it to scrape a trailing
// "== summary (JSON) ==" block if the script prints one.
function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: BENCH_DIR, env: process.env });
    let out = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`${script} exited with code ${code}`));
        return;
      }
      const marker = '== summary (JSON) ==';
      const idx = out.indexOf(marker);
      let summary = null;
      if (idx !== -1) {
        try {
          summary = JSON.parse(out.slice(idx + marker.length).trim());
        } catch {
          summary = null; // best-effort - not every script prints one (verify-sync.mjs doesn't)
        }
      }
      resolve(summary);
    });
  });
}

async function main() {
  console.log('== bench/run-all: verify -> bench:sync -> bench:api ==\n');

  const results = {};

  console.log('--- 1/3: verify-sync.mjs (real-client correctness) ---');
  await runScript(join(BENCH_DIR, 'verify-sync.mjs'));
  results.verify = 'PASSED';

  console.log('\n--- 2/3: sync-latency.mjs (fan-out latency + throughput) ---');
  results.sync = await runScript(join(BENCH_DIR, 'sync-latency.mjs'));

  console.log('\n--- 3/3: api-throughput.mjs (GraphQL request throughput) ---');
  results.api = await runScript(join(BENCH_DIR, 'api-throughput.mjs'));

  console.log('\n== run-all combined summary (JSON) ==');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('\nrun-all FAILED:', err.message);
  process.exit(1);
});
