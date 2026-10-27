// Real-client throughput benchmark for apps/api: drives actual GraphQL HTTP
// requests (Node's built-in fetch, no mocking) against a live server, fully
// authenticated through the real register -> createWorkspace -> createChannel
// flow rather than seeding rows directly - this exercises the exact same
// resolver/guard/service/Prisma path production traffic does, including
// PermissionsGuard's channelId -> Channel -> Workspace resolution on every
// sendMessage call. See docs/BENCHMARKS.md for how to run this and what the
// numbers do/don't mean.
import { setTimeout as sleep } from 'node:timers/promises';
import { execSync } from 'node:child_process';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 5);
const API_PID = process.env.API_PID; // optional: report RSS via `ps` if provided

function rssMb(pid) {
  try {
    return (Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024).toFixed(1);
  } catch {
    return null;
  }
}

function percentile(sortedMs, p) {
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

async function gql(query, variables, token) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

// --- one-time setup: real register -> login-equivalent -> createWorkspace ->
// createChannel, exactly the flow a real client would perform. ---
async function setup() {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `bench-${runId}@example.com`;
  const password = 'bench-throughput-password-1';

  const { register } = await gql(
    `mutation Register($input: RegisterInput!) {
      register(input: $input) { accessToken user { id } }
    }`,
    { input: { email, password, displayName: `bench-${runId}` } },
  );
  const token = register.accessToken;

  const { createWorkspace } = await gql(
    `mutation CreateWorkspace($input: CreateWorkspaceInput!) {
      createWorkspace(input: $input) { id }
    }`,
    { input: { name: `bench-${runId}` } },
    token,
  );

  const { createChannel } = await gql(
    `mutation CreateChannel($input: CreateChannelInput!) {
      createChannel(input: $input) { id }
    }`,
    { input: { workspaceId: createWorkspace.id, name: `bench-${runId}` } },
    token,
  );

  return { token, channelId: createChannel.id, email };
}

// Runs one GraphQL operation in a loop for DURATION_SECONDS, recording
// per-call latency. `op` returns a Promise for a single call.
async function runWorker(op, latencies, stopAt) {
  while (Date.now() < stopAt) {
    const start = process.hrtime.bigint();
    await op();
    latencies.push(Number(process.hrtime.bigint() - start) / 1e6); // ms
  }
}

async function benchOperation(label, op, seedMessages) {
  console.log(`\n-- ${label}: ${CONCURRENCY} concurrent workers, ${DURATION_SECONDS}s window --`);
  if (seedMessages) {
    // Give the `messages` query something non-trivial to page through.
    for (let i = 0; i < 20; i++) await seedMessages();
  }

  const latencies = [];
  const stopAt = Date.now() + DURATION_SECONDS * 1000;
  const start = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => runWorker(op, latencies, stopAt)),
  );
  const elapsedS = (Date.now() - start) / 1000;

  latencies.sort((a, b) => a - b);
  const reqPerSec = latencies.length / elapsedS;
  const result = {
    label,
    requests: latencies.length,
    elapsedS,
    reqPerSec,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
  };

  console.log(
    `${label}: ${result.requests} requests in ${elapsedS.toFixed(2)}s ` +
      `(${reqPerSec.toFixed(1)} req/s) — p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms ` +
      `p99=${result.p99.toFixed(1)}ms max=${result.max.toFixed(1)}ms`,
  );
  return result;
}

async function main() {
  console.log(`== api-throughput benchmark against ${API_URL} ==`);
  if (API_PID) console.log(`api server RSS before: ${rssMb(API_PID)} MB (pid ${API_PID})`);

  const { token, channelId } = await setup();
  console.log(`authenticated bench user, channel ${channelId}`);

  // NOTE: @nestjs/throttler's default 100 req/60s-per-client limit (see
  // docs/ARCHITECTURE.md) applies here - all CONCURRENCY workers share the
  // same bench user/IP, so at default settings you WILL see 429s well
  // before this saturates anything interesting. Either raise the throttle
  // limit for the run or treat 429s below as expected background noise, not
  // benchmark failure (see docs/BENCHMARKS.md).
  let sendFailures = 0;
  const sendMessage = () =>
    gql(
      `mutation SendMessage($input: SendMessageInput!) {
        sendMessage(input: $input) { id }
      }`,
      { input: { channelId, body: 'bench message' } },
      token,
    ).catch((err) => {
      sendFailures++;
      if (sendFailures <= 3) console.warn(`sendMessage failed (may be rate-limited): ${err.message}`);
    });

  const messagesQuery = () =>
    gql(
      `query Messages($input: MessagesQueryInput!) {
        messages(input: $input) { items { id } hasMore }
      }`,
      { input: { channelId, limit: 50 } },
      token,
    );

  const writeResult = await benchOperation('sendMessage (write)', sendMessage);
  await sleep(1000); // let any in-flight throttler window settle between phases
  const readResult = await benchOperation('messages (read)', messagesQuery, sendMessage);

  if (API_PID) console.log(`\napi server RSS after: ${rssMb(API_PID)} MB (pid ${API_PID})`);
  if (sendFailures > 0) {
    console.log(`\n(${sendFailures} sendMessage calls failed during the run - see note above about rate limiting)`);
  }

  console.log('\n== summary (JSON) ==');
  console.log(JSON.stringify({ write: writeResult, read: readResult }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('BENCH FAILED:', err);
  process.exit(1);
});
