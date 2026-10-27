// Connection-scale smoke test: opens many real WebSocket clients across many
// documents against the Go relay and reports connect-time distribution and
// server RSS growth. This is NOT a claim that the system handles the "1000s
// of concurrent connections" design target — that requires multi-machine load
// generation this harness doesn't attempt. It's an honest, reproducible data
// point at a scale a single laptop can drive without lying about the results.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WS from 'ws';
import { execSync } from 'node:child_process';
import pg from 'pg';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { DATABASE_URL, JWT_SECRET } from './lib/seed.mjs';

const SYNC_URL = process.env.SYNC_URL || 'ws://localhost:1234';
const SYNC_PID = process.env.SYNC_PID;
const NUM_DOCS = Number(process.env.NUM_DOCS || 50);
const CLIENTS_PER_DOC = Number(process.env.CLIENTS_PER_DOC || 4);

function rssMb(pid) {
  try {
    return (Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024).toFixed(1);
  } catch {
    return null;
  }
}

async function seedMany(n) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await client.query(
    `INSERT INTO "User" (id, email, "passwordHash", "displayName", "createdAt", "updatedAt") VALUES ($1,$2,'x','scale-bot',now(),now())`,
    [userId, `scale-${userId.slice(0, 8)}@example.com`],
  );
  await client.query(
    `INSERT INTO "Workspace" (id, name, slug, "createdAt", "updatedAt") VALUES ($1,'scale-bench',$2,now(),now())`,
    [workspaceId, `scale-${workspaceId.slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, "joinedAt") VALUES ($1,$2,$3,'MEMBER',now())`,
    [crypto.randomUUID(), workspaceId, userId],
  );
  const documentIds = [];
  for (let i = 0; i < n; i++) {
    const documentId = crypto.randomUUID();
    documentIds.push(documentId);
    await client.query(
      `INSERT INTO "Document" (id, "workspaceId", kind, title, "createdAt", "updatedAt") VALUES ($1,$2,'RICH_TEXT',$3,now(),now())`,
      [documentId, workspaceId, `scale-doc-${i}`],
    );
  }
  const token = jwt.sign({ sub: userId, email: `scale-${userId}@example.com` }, JWT_SECRET, { expiresIn: '15m' });
  return {
    documentIds,
    token,
    async cleanup() {
      for (const id of documentIds) {
        await client.query(`DELETE FROM "DocumentSnapshot" WHERE "documentId"=$1`, [id]);
        await client.query(`DELETE FROM "Document" WHERE id=$1`, [id]);
      }
      await client.query(`DELETE FROM "WorkspaceMember" WHERE "workspaceId"=$1`, [workspaceId]);
      await client.query(`DELETE FROM "Workspace" WHERE id=$1`, [workspaceId]);
      await client.query(`DELETE FROM "User" WHERE id=$1`, [userId]);
      await client.end();
    },
  };
}

async function main() {
  const totalClients = NUM_DOCS * CLIENTS_PER_DOC;
  console.log(`== sync-scale: ${totalClients} clients across ${NUM_DOCS} documents (${CLIENTS_PER_DOC}/doc) ==`);
  if (SYNC_PID) console.log(`RSS before: ${rssMb(SYNC_PID)} MB`);

  const seed = await seedMany(NUM_DOCS);
  const connectTimes = [];
  const clients = [];

  const t0 = Date.now();
  await Promise.all(
    seed.documentIds.flatMap((docId) =>
      Array.from({ length: CLIENTS_PER_DOC }, () => {
        const start = process.hrtime.bigint();
        const doc = new Y.Doc();
        const provider = new WebsocketProvider(SYNC_URL, `doc:${docId}`, doc, {
          params: { token: seed.token },
          WebSocketPolyfill: WS,
        });
        clients.push({ doc, provider });
        return new Promise((resolve) => {
          provider.on('status', (e) => {
            if (e.status === 'connected') {
              connectTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
              resolve();
            }
          });
        });
      }),
    ),
  );
  const totalMs = Date.now() - t0;

  connectTimes.sort((a, b) => a - b);
  const p50 = connectTimes[Math.floor(connectTimes.length * 0.5)];
  const p95 = connectTimes[Math.floor(connectTimes.length * 0.95)];
  const max = connectTimes[connectTimes.length - 1];

  console.log(`all ${totalClients} clients connected in ${totalMs}ms wall clock`);
  console.log(`per-connection handshake time: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  if (SYNC_PID) console.log(`RSS with ${totalClients} live connections across ${NUM_DOCS} rooms: ${rssMb(SYNC_PID)} MB`);

  for (const c of clients) {
    c.provider.destroy();
    c.doc.destroy();
  }
  await new Promise((r) => setTimeout(r, 300));
  if (SYNC_PID) console.log(`RSS after disconnect: ${rssMb(SYNC_PID)} MB`);

  await seed.cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
