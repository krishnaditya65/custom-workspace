# custom-workspace — Test Scripts (reference, NOT executed)

Assumptions to confirm against `bench/verify-sync.mjs`, `bench/lib/seed.mjs`, `apps/api/src/**/*.resolver.ts`, `apps/sync/internal/{protocol,config}`: GraphQL input shapes below; auth payload `{accessToken, refreshToken, user{id}}`; sync URL `ws://host:1234/<docName>?token=<jwt>` speaking the y-websocket/Hocuspocus protocol; doc naming `doc:<uuid>`; snapshot table `documents(name, state bytea)`. Adjust `lib.mjs` only. Needs node ≥ 20 (`cd bench && npm i` gives yjs, y-websocket, ws, jsonwebtoken, pg), bash, curl, jq, docker, go, k6.

## lib.mjs
```js
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import WebSocket from 'ws';
export const API = process.env.API || 'http://localhost:4000/graphql', SYNC = (process.env.SYNC || 'ws://localhost:1234').split(',');
export async function gql(query, variables = {}, token) { const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) }); const j = await r.json().catch(() => ({ errors: [{ message: `HTTP ${r.status}` }] })); return { status: r.status, ...j }; }
export async function user(tag = '') { const email = `u${tag}${Date.now()}${Math.random().toString(36).slice(2)}@qa.io`, password = 'Qa!Passw0rd#1';
  const r = await gql('mutation($i:RegisterInput!){register(input:$i){accessToken refreshToken user{id}}}', { i: { email, password, displayName: 'qa' } }); const p = r.data?.register; if (!p) throw new Error('register failed ' + JSON.stringify(r.errors)); return { email, password, token: p.accessToken, refresh: p.refreshToken, id: p.user.id }; }
export async function workspace(u, name = 'ws') { return (await gql('mutation($i:CreateWorkspaceInput!){createWorkspace(input:$i){id}}', { i: { name } }, u.token)).data.createWorkspace.id; }
export async function channel(u, workspaceId, name = 'general') { return (await gql('mutation($i:CreateChannelInput!){createChannel(input:$i){id}}', { i: { workspaceId, name } }, u.token)).data.createChannel.id; }
export function connect(docName, token, i = 0) { const doc = new Y.Doc(); const provider = new WebsocketProvider(SYNC[i % SYNC.length], docName, doc, { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true }); return { doc, provider, text: doc.getText('t'), synced: () => new Promise(r => provider.synced ? r() : provider.once('synced', r)) }; }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const fingerprint = doc => Buffer.from(Y.encodeStateVector(doc)).toString('hex') + ':' + doc.getText('t').toString().length + ':' + doc.getText('t').toString().slice(0, 64);
let pass = 0, fail = 0; export const t = (id, cond, info = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${id}${cond ? '' : ' :: ' + info}`); }; export const done = () => { console.log(`pass=${pass} fail=${fail}`); process.exit(fail ? 1 : 0); };
```

## smoke.mjs
```js
import { gql, user, workspace, channel, connect, sleep, t, done, API, SYNC } from './lib.mjs';
t('SMK-001 api', (await fetch(API.replace('/graphql', '/health'))).status === 200); t('SMK-001 sync', (await fetch(SYNC[0].replace('ws', 'http') + '/health')).status === 200);
const a = await user('a'); t('SMK-002 me', (await gql('{me{id}}', {}, a.token)).data?.me?.id === a.id);
const ws = await workspace(a), ch = await channel(a, ws);
const m = await gql('mutation($i:SendMessageInput!){sendMessage(input:$i){id}}', { i: { channelId: ch, content: 'hello' } }, a.token); t('SMK-003 send', !!m.data, JSON.stringify(m.errors));
const l = await gql('query($c:ID!){messages(channelId:$c){id content}}', { c: ch }, a.token); t('SMK-003 list', JSON.stringify(l.data).includes('hello'));
const d = `doc:${crypto.randomUUID()}`, c1 = connect(d, a.token), c2 = connect(d, a.token); await Promise.all([c1.synced(), c2.synced()]); c1.text.insert(0, 'ping'); await sleep(1000); t('SMK-004 sync', c2.text.toString() === 'ping', c2.text.toString());
c1.provider.destroy(); c2.provider.destroy(); done();
```

## isolation_matrix.mjs (NEG-001/002/003/005/006/011/014, I4, I5) — P0
```js
import { gql, user, workspace, channel, connect, sleep, t, done, API, SYNC } from './lib.mjs'; import WebSocket from 'ws'; import { createClient } from 'graphql-ws';   // npm i graphql-ws
const owner = await user('o'), outsider = await user('x'); const ws = await workspace(owner), ch = await channel(owner, ws);
const msg = (await gql('mutation($i:SendMessageInput!){sendMessage(input:$i){id}}', { i: { channelId: ch, content: 'SECRET-A' } }, owner.token)).data.sendMessage.id;
const task = (await gql('mutation($i:CreateTaskInput!){createTask(input:$i){id}}', { i: { workspaceId: ws, title: 'SECRET-A' } }, owner.token)).data?.createTask?.id;
const ops = [ ['workspace', 'query($id:ID!){workspace(id:$id){id name}}', { id: ws }], ['channels', 'query($w:ID!){channels(workspaceId:$w){id name}}', { w: ws }], ['messages', 'query($c:ID!){messages(channelId:$c){id content}}', { c: ch }], ['tasks', 'query($w:ID!){tasks(workspaceId:$w){id title}}', { w: ws }], ['events', 'query($w:ID!){events(workspaceId:$w){id title}}', { w: ws }],
  ['createChannel', 'mutation($i:CreateChannelInput!){createChannel(input:$i){id}}', { i: { workspaceId: ws, name: 'pwn' } }], ['sendMessage', 'mutation($i:SendMessageInput!){sendMessage(input:$i){id}}', { i: { channelId: ch, content: 'pwn' } }], ['editMessage', 'mutation($id:ID!,$c:String!){editMessage(id:$id,content:$c){id}}', { id: msg, c: 'pwn' }], ['deleteMessage', 'mutation($id:ID!){deleteMessage(id:$id)}', { id: msg }],
  ['archiveChannel', 'mutation($id:ID!){archiveChannel(id:$id){id}}', { id: ch }], ['assignTask', 'mutation($t:ID!,$u:ID!){assignTask(taskId:$t,userId:$u){id}}', { t: task, u: outsider.id }], ['updateTaskStatus', 'mutation($t:ID!){updateTaskStatus(taskId:$t,status:DONE){id}}', { t: task }], ['createEvent', 'mutation($i:CreateEventInput!){createEvent(input:$i){id}}', { i: { workspaceId: ws, title: 'pwn', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 36e5).toISOString() } }] ];
for (const [name, q, v] of ops) { for (const [who, tok] of [['outsider', outsider.token], ['anonymous', undefined], ['forged', outsider.token.slice(0, -3) + 'AAA']]) { const r = await gql(q, v, tok); const leaked = JSON.stringify(r.data || {}).includes('SECRET-A') || (r.data && Object.values(r.data).some(x => x && (x.id || x === true || (Array.isArray(x) && x.length)))); t(`ISO ${name} as ${who}`, !leaked && !!r.errors, JSON.stringify(r).slice(0, 160)); } }
t('user PII', !JSON.stringify((await gql('query($id:ID!){user(id:$id){id email}}', { id: owner.id }, outsider.token)).data || {}).includes(owner.email), 'outsider can read email');
// subscription leakage
const got = []; const sub = createClient({ url: API.replace('http', 'ws'), webSocketImpl: WebSocket, connectionParams: { Authorization: `Bearer ${outsider.token}` } });
sub.subscribe({ query: 'subscription($c:ID!){messageAdded(channelId:$c){id content}}', variables: { c: ch } }, { next: d => got.push(d), error: () => {}, complete: () => {} });
const anon = createClient({ url: API.replace('http', 'ws'), webSocketImpl: WebSocket }); anon.subscribe({ query: 'subscription($c:ID!){messageAdded(channelId:$c){id content}}', variables: { c: ch } }, { next: d => got.push(d), error: () => {}, complete: () => {} });
await sleep(1000); await gql('mutation($i:SendMessageInput!){sendMessage(input:$i){id}}', { i: { channelId: ch, content: 'SECRET-LIVE' } }, owner.token); await sleep(2000); t('NEG-006 subscription leak', got.filter(g => g.data).length === 0, JSON.stringify(got));
// sync WS authz
const docName = `doc:${crypto.randomUUID()}`; const o = connect(docName, owner.token); await o.synced(); o.text.insert(0, 'SECRET-DOC'); await sleep(500);   // doc must be registered to workspace `ws` per app convention: VERIFY how docs map to workspaces
for (const [who, tok] of [['outsider', outsider.token], ['none', ''], ['garbage', 'x.y.z']]) { const c = connect(docName, tok); await sleep(2500); t(`NEG-011 sync read as ${who}`, c.text.toString() === '', 'outsider received doc content'); c.text.insert(0, 'PWN'); await sleep(1500); t(`NEG-011 sync write as ${who}`, !o.text.toString().includes('PWN'), 'outsider update applied'); c.provider.destroy(); }
// revocation: logout must close/neutralise the socket (CON-003)
const member = await user('m'); /* add member to ws via addMember mutation: VERIFY */ const mc = connect(docName, member.token); await sleep(1500); await gql('mutation{logout}', {}, member.token); await sleep(Number(process.env.REVOKE_MS || 10000)); mc.text.insert(0, 'AFTER-LOGOUT'); await sleep(1500); t('CON-003 write after logout', !o.text.toString().includes('AFTER-LOGOUT'));
// alias bomb vs throttler (NEG-005)
const bomb = 'mutation{' + Array.from({ length: 500 }, (_, i) => `a${i}:login(input:{email:"${owner.email}",password:"wrong${i}"}){accessToken}`).join(' ') + '}'; const rb = await gql(bomb); t('NEG-005 alias bomb limited', !!rb.errors && (rb.errors.length < 500 || /thrott|complex|limit|many/i.test(JSON.stringify(rb.errors))), `${rb.errors?.length} individual attempts executed in one request`);
t('NEG-014 internal', [401, 403, 404].includes((await fetch(API.replace('/graphql', '/internal/sessions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status));
done();
```

## convergence.mjs (RACE-001/002/004/005, FUN-010/011, I1, CON-001) — run with `SYNC=ws://localhost:1234,ws://localhost:1235,ws://localhost:1236` for multi-instance
```js
import * as Y from 'yjs'; import pg from 'pg'; import { user, connect, sleep, fingerprint, t, done } from './lib.mjs';
const SEED = +process.argv[2] || 1, N = +process.env.N || 50, DUR = +process.env.DUR || 60; let s = SEED; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const u = await user('conv'), name = `doc:${crypto.randomUUID()}`; let clients = Array.from({ length: N }, (_, i) => connect(name, u.token, i)); await Promise.all(clients.map(c => c.synced()));
const end = Date.now() + DUR * 1000; let ops = 0;
while (Date.now() < end) { const i = Math.floor(rnd() * N), c = clients[i], len = c.text.length, r = rnd();
  if (r < 0.6) c.text.insert(Math.floor(rnd() * (len + 1)), `[${i}:${ops}]`); else if (r < 0.9 && len > 0) { const p = Math.floor(rnd() * len); c.text.delete(p, Math.min(1 + Math.floor(rnd() * 8), len - p)); }
  else if (r < 0.95) { c.provider.disconnect(); setTimeout(() => c.provider.connect(), 200 + rnd() * 3000); }                       // offline edits continue locally => FUN-010
  else { c.provider.destroy(); clients[i] = connect(name, u.token, Math.floor(rnd() * 8)); }                                       // hard reconnect, possibly to another instance; fresh doc => RACE-004 late joiner
  ops++; if (ops % 20 === 0) await sleep(5); }
clients.forEach(c => c.provider.connect()); await sleep(+process.env.SETTLE || 15000);
const prints = clients.map(c => fingerprint(c.doc)), texts = new Set(clients.map(c => c.text.toString()));
t(`I1 convergence seed=${SEED} clients=${N} ops=${ops}`, texts.size === 1 && new Set(prints).size === 1, `${texts.size} distinct states; lengths=${[...texts].map(x => x.length)}`);
const late = connect(name, u.token, 1); await late.synced(); await sleep(1000); t('RACE-004 late joiner equals', late.text.toString() === clients[0].text.toString());
clients.forEach(c => c.provider.destroy()); late.provider.destroy(); await sleep((+process.env.DEBOUNCE_MS || 2000) + 3000);                // RACE-006: last client left -> snapshot must flush
const db = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/workspace' }); await db.connect();
const row = (await db.query('select state from documents where name=$1', [name])).rows[0]; const snap = new Y.Doc(); if (row) Y.applyUpdate(snap, new Uint8Array(row.state));       // table/column: VERIFY
t('CON-001 snapshot == clients', !!row && snap.getText('t').toString() === [...texts][0], row ? 'content differs' : 'no snapshot row'); await db.end(); done();
```
Seeds: `for s in $(seq 1 20); do node convergence.mjs $s || break; done`.

## frame_fuzz.mjs (NEG-012, I7) + Go fuzz targets
```js
import WebSocket from 'ws'; import zlib from 'node:zlib'; import { user, connect, sleep, t, done, SYNC } from './lib.mjs';
const u = await user('fz'), name = `doc:${crypto.randomUUID()}`, good = connect(name, u.token); await good.synced(); good.text.insert(0, 'intact');
const vi = n => { const o = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return o; };
const cases = { empty: [], oneByte: [0], unknownType: [...vi(99), 1, 2, 3], truncVarint: [0x80], hugeVarint: Array(12).fill(0xff), lenBomb: [0, 2, ...vi(0xffffffff), 1], syncStep2Garbage: [0, 1, 5, 0xde, 0xad, 0xbe, 0xef, 0x00], updateGarbage: [0, 2, 8, ...Array(8).fill(0xff)], awarenessBig: [1, ...vi(1 << 20), ...Array(64).fill(0x41)], random: [...crypto.getRandomValues(new Uint8Array(4096))], gzipBomb: [...zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024))] };
for (const [k, bytes] of Object.entries(cases)) { const ws = new WebSocket(`${SYNC[0]}/${name}?token=${u.token}`); await new Promise(r => ws.once('open', r)); ws.send(Buffer.from(bytes)); if (k === 'empty') ws.send('text frame instead of binary'); await sleep(300); ws.terminate();
  const alive = (await fetch(SYNC[0].replace('ws', 'http') + '/health').catch(() => ({ status: 0 }))).status === 200; t(`NEG-012 ${k}: server alive`, alive); }
const ws = new WebSocket(`${SYNC[0]}/${name}?token=${u.token}`); await new Promise(r => ws.once('open', r)); let sent = 0; ws.on('error', () => {}); for (let i = 0; i < 200000 && ws.readyState === 1; i++) { ws.send(Buffer.from([1, 2, 1, 0])); sent++; } await sleep(1000); t('NEG-012 flood: rate-limited or closed', ws.readyState !== 1 || sent < 200000, 'accepted 200k frames with no limit'); ws.terminate();
const probe = connect(name, u.token); await probe.synced(); await sleep(500); t('state intact after fuzz', probe.text.toString() === 'intact', probe.text.toString().slice(0, 50)); done();
```
```go
// apps/sync/internal/lib0/fuzz_test.go        go test -fuzz=FuzzDecode -fuzztime=1h ./internal/lib0
func FuzzDecode(f *testing.F){ f.Add([]byte{0}); f.Add([]byte{0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x01}); f.Fuzz(func(t *testing.T,b []byte){ d:=NewDecoder(b)
  for i:=0;i<64;i++{ if _,err:=d.ReadVarUint();err!=nil{break}; if _,err:=d.ReadVarString();err!=nil{break}; if _,err:=d.ReadVarBytes();err!=nil{break} } }) }   // must never panic nor allocate > len(b)
func TestVarUintGolden(t *testing.T){ for v,hex:=range map[uint64]string{0:"00",127:"7f",128:"8001",16383:"ff7f",16384:"808001",1<<32:"8080808010",1<<53:"8080808080808010"}{ /* encode(v)==hex && decode(hex)==v — vectors generated with JS lib0 */ _ = v; _ = hex } }
// apps/sync/internal/protocol/fuzz_test.go: FuzzHandleMessage(doc, bytes) — no panic; read-only principal ⇒ doc state unchanged for ANY input (I4 property)
// apps/sync/internal/hub/leak_test.go (RACE-005): 500 conns join/leave randomly ×100 rounds with -race; at end len(rooms)==0 and runtime.NumGoroutine() back to baseline (goleak)
// apps/sync/internal/store/monotonic_test.go (RACE-003, I3): two writers; W1 saves state{a,b}, W2 (stale, only {a}) saves later ⇒ stored state still contains b (merge/CAS)
// apps/sync/internal/rbac/parity_test.go (INT-009): load ../../../../tests/fixtures/rbac-table.json (shared with apps/api/src/common/rbac spec) and assert identical decisions
```

## durability_chaos.sh (DUR-001..003, CHA-001/002/004/005/008)
```bash
#!/usr/bin/env bash
set -u; DC="docker compose -f ../infra/docker-compose.yml"; SYNCPAT=${SYNCPAT:-'cmd/sync|/sync$'}; START_SYNC=${START_SYNC:-'cd ../apps/sync && PORT=1234 INSTANCE_ID=a nohup go run ./cmd/sync >/tmp/sync.log 2>&1 &'}
PASS=0; FAIL=0; res(){ [[ $1 == 0 ]] && { PASS=$((PASS+1)); echo "PASS $2"; } || { FAIL=$((FAIL+1)); echo "FAIL $2"; }; }
conv(){ DUR=${2:-60} N=30 SETTLE=${3:-20000} node convergence.mjs $1 & W=$!; }
conv 101; sleep 20; pkill -KILL -f "$SYNCPAT"; sleep 3; eval "$START_SYNC"; wait $W; res $? "CHA-001 kill -9 sync mid-edit (clients heal state)"
conv 102; sleep 20; pkill -TERM -f "$SYNCPAT"; sleep 5; eval "$START_SYNC"; wait $W; res $? "DUR-003 SIGTERM flush + rejoin"
conv 103 60 40000; sleep 15; $DC stop redis; sleep 30; $DC start redis; wait $W; res $? "CHA-002 redis outage (multi-instance must reconverge: run with SYNC=3 instances)"
conv 104 60 40000; sleep 15; $DC pause postgres; sleep 30; $DC unpause postgres; wait $W; res $? "CHA-004 postgres outage (snapshots retried)"
conv 105 60 40000; sleep 15; pkill -STOP -f "$SYNCPAT"; sleep 30; pkill -CONT -f "$SYNCPAT"; wait $W; res $? "CHA-008 paused instance must not clobber newer snapshot"
# DUR-001/002: single writer, no surviving client => measures raw server durability window
node - <<'EOF'
import('./lib.mjs').then(async ({ user, connect, sleep }) => { const u = await user('dur'), name = `doc:${crypto.randomUUID()}`, c = connect(name, u.token); await c.synced();
  for (let i = 0; i < 50; i++) { c.text.insert(c.text.length, `<${i}>`); await sleep(100); } await sleep(Number(process.env.DEBOUNCE_MS || 2000) + 1000); c.text.insert(c.text.length, '<LATE>'); await sleep(50);
  require('fs').writeFileSync('/tmp/dur.json', JSON.stringify({ name, token: u.token })); c.provider.destroy(); process.exit(0); });
EOF
pkill -KILL -f "$SYNCPAT"; sleep 2; eval "$START_SYNC"; sleep 5
node -e "import('./lib.mjs').then(async({connect,sleep})=>{const {name,token}=JSON.parse(require('fs').readFileSync('/tmp/dur.json'));const c=connect(name,token);await c.synced();await sleep(500);const s=c.text.toString();console.log(s.includes('<49>')?'PASS DUR-001 pre-debounce edits durable':'FAIL DUR-001 lost debounced edits');console.log('INFO DUR-002 in-window edit '+(s.includes('<LATE>')?'survived':'lost (acceptable only within documented debounce window)'));process.exit(s.includes('<49>')?0:1)})"; res $? DUR-001
# CHA-005 api down => new sync connections must fail closed, quickly
pkill -STOP -f 'apps/api|nest start'; s=$(date +%s); node -e "import('./lib.mjs').then(async({connect,sleep})=>{const c=connect('doc:x','any.token.here');await sleep(8000);console.log(c.provider.synced?'FAIL CHA-005 fail-open':'PASS CHA-005 fail-closed');process.exit(c.provider.synced?1:0)})"; res $? CHA-005; pkill -CONT -f 'apps/api|nest start'
echo "pass=$PASS fail=$FAIL"; [[ $FAIL == 0 ]]
```

## chat_order.mjs (RACE-008, I6, CON-002) — point `API_SUBS` at 2 API replicas
```js
import WebSocket from 'ws'; import { createClient } from 'graphql-ws'; import { gql, user, workspace, channel, sleep, t, done, API } from './lib.mjs';
const SUBS = (process.env.API_SUBS || API).split(',').map(u => u.replace('http', 'ws')); const o = await user('ord'), ws = await workspace(o), ch = await channel(o, ws); const seen = SUBS.flatMap(u => [0, 1, 2].map(() => ({ url: u, ids: [] })));
for (const s of seen) createClient({ url: s.url, webSocketImpl: WebSocket, connectionParams: { Authorization: `Bearer ${o.token}` } }).subscribe({ query: 'subscription($c:ID!){messageAdded(channelId:$c){id}}', variables: { c: ch } }, { next: d => s.ids.push(d.data.messageAdded.id), error: e => console.log('sub error', e), complete: () => {} });
await sleep(1500); const sent = await Promise.all(Array.from({ length: 300 }, (_, i) => gql('mutation($i:SendMessageInput!){sendMessage(input:$i){id}}', { i: { channelId: ch, content: `m${i}` } }, o.token))); const okIds = sent.filter(r => r.data).map(r => r.data.sendMessage.id); await sleep(4000);
const db = (await gql('query($c:ID!){messages(channelId:$c,first:1000){id}}', { c: ch }, o.token)).data.messages.map(m => m.id);
t('persisted == acked', db.length === okIds.length && new Set(db).size === db.length, `${db.length} vs ${okIds.length}`);
seen.forEach((s, i) => { t(`sub ${i} no loss/dup`, s.ids.length === okIds.length && new Set(s.ids).size === s.ids.length, `${s.ids.length}/${okIds.length}`); t(`sub ${i} order == DB order`, s.ids.join() === [...db].sort((a, b) => db.indexOf(a) - db.indexOf(b)).join() || s.ids.join() === [...db].reverse().join(), 'order differs (check which direction messages() returns)'); });
const refresh = await Promise.all(Array.from({ length: 50 }, () => gql('mutation($t:String!){refreshToken(token:$t){accessToken}}', { t: o.refresh }))); t('RACE-009 refresh single-use', refresh.filter(r => r.data?.refreshToken).length <= 1, `${refresh.filter(r => r.data?.refreshToken).length} successes`);
done();
```

## Load
Existing harness first (authoritative): `cd bench && npm run verify && npm run bench:sync && npm run bench:sync-scale && npm run bench:api && npm run bench:all`; compare with `docs/BENCHMARKS.md` (fail on > 10 % regression). Add profiles by env: load (steady 10 min), stress (double clients every 2 min until p99 > 1 s or errors), spike (0 → 5k connects in 5 s, ×3), soak (24 h at 30 %, sampling `curl sync/health`, RSS, goroutines via pprof, `pg_stat_activity` count, `redis-cli -p 6390 info memory`).
```js
// api.k6.js — k6 run -e PROFILE=load api.k6.js   (tokens.json: [{token, channelId}] produced by bench/lib/seed.mjs)
import http from 'k6/http'; import { check } from 'k6'; import { SharedArray } from 'k6/data';
const API = __ENV.API || 'http://localhost:4000/graphql', U = new SharedArray('u', () => JSON.parse(open('./tokens.json')));
const P = { load: [{ duration: '1m', target: 200 }, { duration: '8m', target: 200 }, { duration: '1m', target: 0 }], stress: [{ duration: '2m', target: 400 }, { duration: '3m', target: 1500 }, { duration: '3m', target: 5000 }, { duration: '2m', target: 0 }], spike: [{ duration: '2s', target: 3000 }, { duration: '45s', target: 3000 }, { duration: '2s', target: 0 }, { duration: '45s', target: 0 }, { duration: '2s', target: 3000 }, { duration: '45s', target: 3000 }], soak: [{ duration: '24h', target: 80 }] };
export const options = { stages: P[__ENV.PROFILE || 'load'], thresholds: { http_req_duration: ['p(99)<200'], checks: ['rate>0.999'] } };
export default function () { const u = U[__VU % U.length], H = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` } }, r = Math.random();
  const body = r < 0.6 ? { query: 'query($c:ID!){messages(channelId:$c,first:50){id content}}', variables: { c: u.channelId } } : r < 0.9 ? { query: 'mutation($i:SendMessageInput!){sendMessage(input:$i){id}}', variables: { i: { channelId: u.channelId, content: `k6 ${__VU}-${__ITER}` } } } : { query: '{me{id} myWorkspaces{id}}' };
  const res = http.post(API, JSON.stringify(body), H); check(res, { 'http 200': x => x.status === 200, 'no gql errors (or throttled)': x => !x.json('errors') || /thrott/i.test(x.body) }); }
```

## Playwright E2E skeleton (E2E-001/002/003) — `tests/e2e/collab.spec.ts`
```ts
import { test, expect } from '@playwright/test';
test('two users converge, survive offline and reload', async ({ browser }) => { const A = await browser.newContext(), B = await browser.newContext(); const a = await A.newPage(), b = await B.newPage();
  for (const [p, n] of [[a, 'a'], [b, 'b']] as const) { await p.goto('/register'); await p.fill('[name=email]', `${n}${Date.now()}@qa.io`); await p.fill('[name=password]', 'Qa!Passw0rd#1'); await p.click('button[type=submit]'); }   // selectors: VERIFY
  /* a creates workspace + doc, invites b (UI or API), both open docUrl */ const ed = '.ProseMirror';
  await Promise.all([a.locator(ed).pressSequentially('AAAAAAAAAA', { delay: 20 }), b.locator(ed).pressSequentially('BBBBBBBBBB', { delay: 20 })]);
  await expect.poll(async () => (await a.locator(ed).innerText()) === (await b.locator(ed).innerText())).toBe(true); const txt = await a.locator(ed).innerText(); expect(txt.match(/A/g)?.length).toBe(10); expect(txt.match(/B/g)?.length).toBe(10);
  await B.setOffline(true); await b.locator(ed).pressSequentially(' offline-b'); await a.locator(ed).pressSequentially(' online-a'); await B.setOffline(false);
  await expect.poll(async () => (await a.locator(ed).innerText()) === (await b.locator(ed).innerText()), { timeout: 15000 }).toBe(true); expect(await a.locator(ed).innerText()).toContain('offline-b');
  await a.reload(); await expect(a.locator(ed)).toContainText('offline-b'); await a.locator(ed).pressSequentially('<img src=x onerror=window.__xss=1>'); expect(await b.evaluate(() => (window as any).__xss)).toBeUndefined(); });
```

## Run order
`pnpm test:unit` + `go test -race ./...` (apps/sync) + Go fuzz (short) → smoke → isolation_matrix → `bench verify` → convergence (20 seeds, single instance) → convergence (3 instances) → chat_order → frame_fuzz → durability_chaos → bench/k6 load → stress/spike → Playwright E2E → soak.
