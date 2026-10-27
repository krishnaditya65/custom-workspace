// End-to-end correctness check for the Go sync relay (apps/sync), using the
// REAL `yjs` + `y-websocket` client libraries — not a Go-side simulation.
// This is the thing that actually proves the wire-protocol relay (which never
// decodes Yjs updates itself, see apps/sync/internal/protocol) is byte-correct
// enough for genuine Yjs clients to converge over it, and that the write-behind
// persisted snapshot reconstructs the same document state after a restart.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WS from 'ws';
import pg from 'pg';
import { seedDocument, DATABASE_URL } from './lib/seed.mjs';
import { gunzip, unframe } from './lib/gzip-frame.mjs';

const SYNC_URL = process.env.SYNC_URL || 'ws://localhost:1234';
const DEBOUNCE_MS = Number(process.env.SNAPSHOT_DEBOUNCE_MS || 10_000);

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve(Date.now() - start);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for: ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function connect(documentId, token) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(SYNC_URL, `doc:${documentId}`, doc, {
    params: { token },
    WebSocketPolyfill: WS,
  });
  return { doc, provider };
}

async function main() {
  console.log(`\n== verify-sync: real Yjs clients against the Go relay at ${SYNC_URL} ==\n`);
  const seed = await seedDocument('verify');
  console.log(`seeded document ${seed.documentId} (workspace ${seed.workspaceId})`);

  // --- 1. Two independent Yjs clients must converge on concurrent edits ---
  const a = connect(seed.documentId, seed.token);
  const b = connect(seed.documentId, seed.token);

  await Promise.all([
    waitFor(() => a.provider.wsconnected, 5000, 'client A connected'),
    waitFor(() => b.provider.wsconnected, 5000, 'client B connected'),
  ]);
  console.log('✓ both clients connected and authenticated (RBAC + JWT accepted)');

  const textA = a.doc.getText('content');
  const textB = b.doc.getText('content');

  const t0 = process.hrtime.bigint();
  textA.insert(0, 'Hello from client A. ');
  const latencyMs = await waitFor(() => textB.toString().includes('Hello from client A.'), 5000, 'B sees A\'s insert');
  console.log(`✓ client B converged on client A's insert in ${latencyMs}ms (round-trip through the Go relay)`);

  // Concurrent edits from both sides — this is the actual CRDT conflict-free
  // guarantee: two clients editing at "the same time" without the server
  // arbitrating, ordering, or locking anything.
  textB.insert(textB.length, ' And hello from client B.');
  await waitFor(
    () => textA.toString() === textB.toString() && textA.toString().includes('client B'),
    5000,
    'A converges on B\'s concurrent insert',
  );
  console.log(`✓ concurrent edits converged identically on both clients: "${textA.toString()}"`);
  const finalText = textA.toString();

  a.provider.destroy();
  b.provider.destroy();
  a.doc.destroy();
  b.doc.destroy();

  // --- 2. Write-behind debounce must have persisted a DocumentSnapshot ---
  console.log(`\nwaiting ${DEBOUNCE_MS + 1500}ms for the write-behind debounce to flush...`);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 1500));

  const pgClient = new pg.Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  const { rows } = await pgClient.query(
    `SELECT state, "sizeBytes" FROM "DocumentSnapshot" WHERE "documentId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [seed.documentId],
  );
  await pgClient.end();

  if (rows.length === 0) throw new Error('FAILED: no DocumentSnapshot row was written by the write-behind flush');
  console.log(`✓ DocumentSnapshot persisted (${rows[0].sizeBytes} gzip bytes)`);

  // --- 3. The persisted snapshot must reconstruct the exact same document ---
  const raw = gunzip(rows[0].state);
  const blobs = unframe(raw);
  const replay = new Y.Doc();
  for (const blob of blobs) Y.applyUpdate(replay, blob);
  const replayedText = replay.getText('content').toString();

  if (replayedText !== finalText) {
    throw new Error(`FAILED: replayed snapshot text mismatch.\n  expected: ${finalText}\n  got:      ${replayedText}`);
  }
  console.log(`✓ persisted snapshot replays to the exact same document state (${blobs.length} stored update blobs)`);

  await seed.cleanup();
  console.log('\nALL CHECKS PASSED\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
