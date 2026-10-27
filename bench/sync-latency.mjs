// Real-client benchmark for the Go sync relay: fan-out latency (one client
// edits, how long until N others see it) and sustained update throughput.
// All numbers are measured against a live server on localhost — see
// docs/BENCHMARKS.md for the actual recorded run and its caveats (loopback
// network, single machine, no concurrent unrelated load).
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WS from 'ws';
import { execSync } from 'node:child_process';
import { seedDocument } from './lib/seed.mjs';

const SYNC_URL = process.env.SYNC_URL || 'ws://localhost:1234';
const FANOUT_CLIENTS = Number(process.env.FANOUT_CLIENTS || 10);
const FANOUT_ROUNDS = Number(process.env.FANOUT_ROUNDS || 50);
const THROUGHPUT_SECONDS = Number(process.env.THROUGHPUT_SECONDS || 5);
const SYNC_PID = process.env.SYNC_PID; // optional: report RSS via `ps` if provided

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function rssMb(pid) {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return (Number(out) / 1024).toFixed(1);
  } catch {
    return null;
  }
}

function connect(documentId, token) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(SYNC_URL, `doc:${documentId}`, doc, {
    params: { token },
    WebSocketPolyfill: WS,
  });
  return { doc, provider };
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 1);
    };
    tick();
  });
}

async function benchFanout(documentId, token) {
  console.log(`\n-- Fan-out latency: 1 sender -> ${FANOUT_CLIENTS - 1} receivers, ${FANOUT_ROUNDS} rounds --`);
  const clients = Array.from({ length: FANOUT_CLIENTS }, () => connect(documentId, token));
  await Promise.all(clients.map((c) => waitFor(() => c.provider.wsconnected, 5000)));
  await new Promise((r) => setTimeout(r, 200)); // let initial handshake settle

  const sender = clients[0];
  const receivers = clients.slice(1);
  const senderText = sender.doc.getText('content');
  const latencies = [];

  for (let i = 0; i < FANOUT_ROUNDS; i++) {
    const marker = `x`;
    const before = process.hrtime.bigint();
    senderText.insert(senderText.length, marker);
    const expectedLen = senderText.length;
    await Promise.all(
      receivers.map((r) => waitFor(() => r.doc.getText('content').length >= expectedLen, 2000)),
    );
    const after = process.hrtime.bigint();
    latencies.push(Number(after - before) / 1e6); // ms
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies[latencies.length - 1];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log(
    `fan-out to ${FANOUT_CLIENTS - 1} receivers: avg=${avg.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
  );

  for (const c of clients) {
    c.provider.destroy();
    c.doc.destroy();
  }
  return { avg, p50, p95, p99, max, clients: FANOUT_CLIENTS };
}

async function benchThroughput(documentId, token) {
  console.log(`\n-- Sustained throughput: 1 writer, ${THROUGHPUT_SECONDS}s window, ${FANOUT_CLIENTS - 1} observers --`);
  const clients = Array.from({ length: FANOUT_CLIENTS }, () => connect(documentId, token));
  await Promise.all(clients.map((c) => waitFor(() => c.provider.wsconnected, 5000)));
  await new Promise((r) => setTimeout(r, 200));

  const sender = clients[0];
  const receivers = clients.slice(1);
  const senderText = sender.doc.getText('content');

  let receivedCount = 0;
  const observers = receivers.map((r) => {
    const text = r.doc.getText('content');
    const handler = (event) => {
      receivedCount += event.changes.delta.reduce((n, d) => n + (d.insert?.length || 0), 0);
    };
    text.observe(handler);
    return () => text.unobserve(handler);
  });

  let sent = 0;
  const start = Date.now();
  while (Date.now() - start < THROUGHPUT_SECONDS * 1000) {
    senderText.insert(senderText.length, 'a');
    sent++;
    // Yield to the event loop so the websocket can actually flush frames
    // instead of this tight loop starving the I/O callbacks.
    if (sent % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 500)); // drain in-flight messages

  const elapsedS = (Date.now() - start) / 1000;
  const sentPerSec = sent / elapsedS;
  const observedPerSecPerClient = receivedCount / (receivers.length * elapsedS);

  console.log(
    `writer sent ${sent} updates in ${elapsedS.toFixed(2)}s (${sentPerSec.toFixed(0)} updates/sec); ` +
      `each of ${receivers.length} observers received ~${observedPerSecPerClient.toFixed(0)} chars/sec fanned out`,
  );

  observers.forEach((unobserve) => unobserve());
  for (const c of clients) {
    c.provider.destroy();
    c.doc.destroy();
  }
  return { sent, sentPerSec, elapsedS };
}

async function main() {
  console.log(`== sync-latency benchmark against ${SYNC_URL} ==`);
  if (SYNC_PID) console.log(`sync server RSS before: ${rssMb(SYNC_PID)} MB (pid ${SYNC_PID})`);

  const seed = await seedDocument('bench-fanout');
  const fanout = await benchFanout(seed.documentId, seed.token);

  const seed2 = await seedDocument('bench-throughput');
  const throughput = await benchThroughput(seed2.documentId, seed2.token);

  if (SYNC_PID) console.log(`\nsync server RSS after: ${rssMb(SYNC_PID)} MB (pid ${SYNC_PID})`);

  await seed.cleanup();
  await seed2.cleanup();

  console.log('\n== summary (JSON) ==');
  console.log(JSON.stringify({ fanout, throughput }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('BENCH FAILED:', err);
  process.exit(1);
});
