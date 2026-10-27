# custom-workspace (NestJS GraphQL API + Go Yjs sync relay) — Performance, Profiling & Benchmarking Reference (04)

Audience: LLM agents / engineers. Companion to 01/02/03. **[src]** = read from source. Targets are hypotheses to calibrate. Nothing executed.

## 0. Limits
Covers real-time collaboration latency/fan-out, sync-server connection scaling, persistence (snapshot) behaviour, GraphQL API throughput, subscriptions, and database cost for the listed workloads. Passing does not prove absence of performance defects for other document sizes, edit patterns, or hardware. **Every sync load run must end with a convergence check (§3.3): fast but diverged documents = failed run.**

## 1. Performance model [src]

| Component | Port | Perf-relevant behaviour |
|---|---|---|
| `apps/sync` (Go, gorilla/websocket, pgx, go-redis) | 1234 (`PORT`) | Yjs/Hocuspocus-style protocol (`internal/{lib0, protocol, hub, redisbus, store, rbac, sessionsclient}`); one Room per document; per-client `sendCh` buffer **256 messages; when full the update is dropped** with log "send buffer full, dropping slow consumer" [src hub/client.go:17,60-63]; `writeWait 10s`, `pongWait 60s`; **snapshot write-behind debounce `SNAPSHOT_DEBOUNCE_MS` default 10 000 ms** [src config.go:28]; session verification via API `/internal/sessions` with `SESSION_VERIFY_TIMEOUT_MS` default 3000; Redis pub/sub bus for multi-instance fan-out (`INSTANCE_ID`); read limit 10 MB, `CheckOrigin` always true [02] |
| `apps/api` (NestJS, Apollo GraphQL, graphql-ws subscriptions via `graphql-redis-subscriptions`, Prisma, bcrypt, ioredis) | 4000 | throttler 100 req / 60 s [02] (disable/raise for capacity tests); JWT access 15 m, guest 30 m |
| Postgres | 5432 | Prisma for API; pgx for sync snapshots |
| Redis | 6379 | sync bus, GraphQL subscriptions pub/sub, throttler? |
| `apps/web` | 8080→80 (prod) | Yjs + ProseMirror client |

Existing harness [src `bench/`, `@workspace/bench`]: `verify-sync.mjs` (real-client correctness), `sync-latency.mjs` (env `SYNC_URL`, `FANOUT_CLIENTS`=10, `FANOUT_ROUNDS`=50, `THROUGHPUT_SECONDS`=5, `SYNC_PID` for RSS; prints fan-out p50/p95/p99/max), `sync-scale.mjs` (`NUM_DOCS`=50, `CLIENTS_PER_DOC`=4; handshake p50/p95/max), `api-throughput.mjs` (`API_URL`, `CONCURRENCY`=20, `DURATION_SECONDS`=5, `API_PID`; req/s + p50/p95/p99/max), `run-all.mjs` (prints combined JSON), `lib/{seed.mjs, gzip-frame.mjs}`. Scripts: `npm run verify | bench:sync | bench:sync-scale | bench:api | bench:all`.
Metrics endpoints: **none found** for sync (no promhttp/pprof) or api (no prom-client) ⇒ add in perf builds.

Latency model for an edit: client encodes Yjs update → WS frame → sync reads, RBAC check (VIEW-only clients rejected; COMMENT can edit — 02 finding) → apply to room doc (in-memory Y.Doc equivalent / update log) → broadcast to N−1 local clients (each via sendCh) + publish to Redis → other instances → their clients. Persistence happens later (debounce 10 s) ⇒ **crash window up to 10 s of edits** unless Redis/other instance holds them.

## 2. Environment rules
Record Go and Node versions, `GOMAXPROCS`, `SNAPSHOT_DEBOUNCE_MS`, instances count, Redis/Postgres versions, OS limits (`ulimit -n` ≥ 200k for connection tests; `net.core.somaxconn`; ephemeral port range on the client host — 1 client IP gives ~28k–64k conns, use multiple source IPs for > 50k). Generator on separate host. Warm-up 30 s. 3 reps, CV < 5%.

## 3. Data-retrieval contract
`perf-results/workspace/<YYYYMMDD-HHMM>-<sha>/<scenario>/`: `meta.json`, `bench-run-all.json` (stdout of `run-all.mjs`), `sync-latency.txt`, `sync-scale.txt`, `api-throughput.txt`, `edits.csv` (custom runner: `doc, sender, seq, t_send_ms, receiver, t_recv_ms`), `convergence.json`, `k6-*.json`, `sync/pprof/*`, `api/profiles/*`, `pg/statements.csv`, `redis/{info.txt,pubsub.txt}`, `host/pidstat.txt`, `summary.json`.
```json
{"project":"workspace","scenario":"PERF-SYNC-04","git":"…","instances":2,"docs":500,"clients_per_doc":20,"edit_rate_per_client_s":2,
 "fanout_ms":{"p50":7,"p95":19,"p99":41,"max":180},"handshake_ms":{"p50":35,"p99":120},"dropped_updates":0,
 "converged":true,"sync":{"cpu_cores":3.2,"rss_mb":640,"goroutines":20210,"conns":10000},"redis_msgs_s":20000,
 "snapshot_writes_s":48,"pass":true}
```
### 3.1 Existing harness → JSON
`node bench/run-all.mjs > $OUT/bench-run-all.json` (already JSON [src]); for single scripts capture stdout and parse lines `p50=…ms p95=…ms p99=…ms max=…ms` with `grep -oE 'p(50|95|99)=[0-9.]+ms'`.
### 3.2 Dropped-update counter (ground truth)
Count server log lines: `grep -c 'send buffer full, dropping slow consumer' sync.log` → `dropped_updates`. Must be 0 in all non-slow-client scenarios.
### 3.3 Convergence check (after every sync run)
For each document: connect a fresh observer client, wait for sync step 2, compute `Y.encodeStateVector` + text/content hash; compare to every live client's hash (each load client reports its final hash) **and** to the persisted snapshot after debounce + 2 s (`SELECT … FROM document snapshots` — VERIFY table/column, via `DATABASE_URL`). Write `convergence.json` `{doc, hashes:{…}, persisted_hash, converged:bool}`. Any `false` ⇒ run fails.

## 4. Tool matrix
| Need | Tool | Command |
|---|---|---|
| Real Yjs clients | existing `bench/*.mjs` (yjs + y-websocket) | `SYNC_URL=ws://host:1234 FANOUT_CLIENTS=50 node bench/sync-latency.mjs` |
| Large connection counts | custom Node runner with many processes (§8.1), `k6` + `k6/ws` (raw protocol frames), `artillery` | |
| GraphQL load | `api-throughput.mjs`, k6, `autocannon -m POST -b '{"query":…}'` | |
| GraphQL subscriptions | k6 + `graphql-ws` via xk6 or custom node client (`graphql-ws` lib) | |
| Go sync profiling | pprof (perf build), `go tool trace`, benchstat | |
| Node API profiling | `--cpu-prof`, `clinic doctor/flame/bubbleprof`, `0x`, heap snapshots | |
| Prisma | `prisma` query event logging (`log:[{level:'query',emit:'event'}]`) with durations; pg_stat_statements | N+1 detection |
| Redis | `INFO commandstats`, `PUBSUB NUMSUB`, `--latency-history`, `CLIENT LIST` (output buffer sizes for slow subscribers) | |
| Network | `ss -s`, `sar -n DEV`, `nstat` | |

## 5. Micro-benchmarks
| ID | Target | Benchmark | Record |
|---|---|---|---|
| MB-01 | `apps/sync/internal/lib0` | varint/varstring encode/decode | ns/op, allocs |
| MB-02 | `internal/protocol` | parse sync step1/step2/update/awareness messages 100 B/10 KB/1 MB | ns/op, MB/s, allocs |
| MB-03 | `internal/hub` | broadcast to 1/10/100/1000 clients in a room (fake conns) | ns/op per broadcast, allocs (payload copied per client?) |
| MB-04 | `internal/rbac` | permission check | ns/op |
| MB-05 | `internal/redisbus` | publish/consume against local Redis | msgs/s |
| MB-06 | `internal/store` | snapshot save/load sizes 10 KB/1 MB/10 MB | ms/op |
| MB-07 | `bench/lib/gzip-frame.mjs` | gzip frame encode | MB/s |
| MB-08 (Node) | Yjs apply/merge updates: doc with 10k/100k edits; `Y.mergeUpdates` | ms/op (server may store update log) |
| MB-09 (Node) | bcrypt login cost (API) | ms/op, event loop blocked (native bcrypt uses threadpool — check `UV_THREADPOOL_SIZE`) |
| MB-10 (Node) | GraphQL execution of top 5 operations with mocked Prisma | ops/s |
```bash
cd apps/sync && go test -run='^$' -bench=. -benchmem -count=10 ./internal/... | tee $OUT/sync-micro.txt && benchstat base/sync-micro.txt $OUT/sync-micro.txt
```

## 6. Macro scenarios
### 6.1 Sync — latency & fan-out
| ID | Workload | Measure | Target (calibrate) |
|---|---|---|---|
| PERF-SYNC-01 | `bench:sync` defaults (10 clients, 50 rounds) | fan-out p50/p99 | baseline |
| PERF-SYNC-02 | 1 doc × clients 2/10/50/200/1000, each 1 edit/s | fan-out p99 vs room size; CPU per broadcast | p99 < 100 ms at 200 |
| PERF-SYNC-03 | Typing burst: 20 clients × 20 keystrokes/s | p99, update batching, dropped=0 | |
| PERF-SYNC-04 | 500 docs × 20 clients, 2 edits/s each (20k msg/s in, 380k out) | throughput, CPU, RSS, goroutines (≈ 2 per conn) | |
| PERF-SYNC-05 | Awareness (cursor) updates 10 Hz per client | bandwidth & CPU share vs doc updates | |
| PERF-SYNC-06 | Large paste 1 MB / 9 MB (< 10 MB read limit) / 11 MB | latency, memory, rejection behaviour | |
| PERF-SYNC-07 | Large doc join: doc with 100k edits history; new client sync step | handshake → first render time, server CPU, bytes sent | |
### 6.2 Sync — connections & scale-out
| ID | Workload | Measure |
|---|---|---|
| PERF-CONN-01 | `bench:sync-scale` NUM_DOCS 50→2000, CLIENTS_PER_DOC 4→10 | handshake p95, RSS/conn, goroutines/conn |
| PERF-CONN-02 | 50k idle connections (heartbeat only) | RSS per conn, CPU idle cost (ping/pong 60 s) |
| PERF-CONN-03 | Connection storm: 10k connects in 10 s | handshake p99 incl. `/internal/sessions` verify (API becomes bottleneck? 3 s timeout ⇒ failures) |
| PERF-CONN-04 | Reconnect storm after sync restart (all clients reconnect) | time to full recovery, API session-verify load, thundering herd |
| PERF-SCALE-01 | Instances 1/2/4 behind LB, clients of a doc spread across instances | cross-instance fan-out latency (Redis hop), Redis msgs/s, CPU |
| PERF-SCALE-02 | Redis latency +5/+20 ms (toxiproxy) | cross-instance latency shift; local fan-out unaffected |
### 6.3 Sync — slow clients, persistence, durability
| ID | Workload | Measure |
|---|---|---|
| PERF-SLOW-01 | 1 of 50 clients reads slowly (throttled socket 10 KB/s) during typing burst | other clients' p99 unaffected; **slow client's dropped updates > 0 ⇒ then convergence check on that client (expected divergence ⇒ finding unless it resyncs)** |
| PERF-SLOW-02 | Many slow clients (10%) | memory bounded (256-msg buffers), CPU |
| PERF-PERS-01 | Snapshot write rate with 2000 active docs, debounce 10 s (default) vs 1 s | Postgres writes/s, snapshot size, DB CPU |
| PERF-PERS-02 | kill -9 sync during typing | edits lost = edits within debounce window not elsewhere persisted — measure with sequence numbers |
| PERF-PERS-03 | Room eviction (`ReleaseIfEmpty`) churn: docs opened/closed 100/s | flush cost, hydrate cost |
### 6.4 API (GraphQL)
| ID | Workload | Measure |
|---|---|---|
| PERF-API-01 | `bench:api` CONCURRENCY 20→200, DURATION 60 s (throttler raised) | req/s, p99, RSS |
| PERF-API-02 | Top 10 operations from 02 (workspaces, documents list, tasks by status, comments) | per-op p99, Prisma queries per op (N+1) |
| PERF-API-03 | Mutations: create task / update status / add comment at 200/s | p99, DB locks |
| PERF-API-04 | Subscriptions: 5k subscribers to task updates; 100 mutations/s | event delivery p99, Redis pub/sub load |
| PERF-API-05 | Login 50/s (bcrypt) + reads | read p99 impact |
| PERF-API-06 | `/internal/sessions` verify at 2k/s (sync storms) | p99 < 3 s timeout with margin |
| PERF-API-07 | Throttler accuracy at default 100/60 s | 429 rate correct, overhead |
| PERF-API-08 | Deep/large GraphQL query (no complexity limit?) | CPU per query |
### 6.5 Stress / soak
| ID | Procedure | Pass |
|---|---|---|
| PERF-STRESS-01 | Ramp SYNC-04 until fan-out p99 > 1 s or drops > 0 | breaking point & failure mode (CPU, Redis, GC, fd) |
| PERF-SOAK-01 | 12 h: 300 docs × 10 clients typing 1/s + API mix 100 rps | sync RSS/goroutines flat (rooms evicted), API heap flat, Postgres snapshot table bloat bounded, convergence true at end |

## 7. Profiling playbooks
### 7.1 Sync (Go)
Perf build (tag `pprof`): `net/http/pprof` on 127.0.0.1:6060, `SetMutexProfileFraction(5)`, `SetBlockProfileRate(1e6)`; optional `promhttp` with gauges: rooms, clients, sendCh len histogram, dropped counter, redis publish latency, snapshot flush duration.
```bash
B=http://127.0.0.1:6060/debug/pprof
curl -s "$B/profile?seconds=30" > $OUT/sync/pprof/cpu.pb.gz; curl -s $B/heap > $OUT/sync/pprof/heap.pb.gz
curl -s $B/allocs > $OUT/sync/pprof/allocs.pb.gz; curl -s $B/mutex > $OUT/sync/pprof/mutex.pb.gz
curl -s "$B/goroutine?debug=1" | head -50 > $OUT/sync/pprof/goroutine.txt; curl -s "$B/trace?seconds=5" > $OUT/sync/pprof/trace.out
go tool pprof -top -nodecount=40 $OUT/sync/pprof/cpu.pb.gz > $OUT/sync/pprof/cpu.top.txt
```
Expected: `websocket.(*Conn).WriteMessage`/syscalls dominate at high fan-out; per-client payload copies in `mallocgc`; room mutex contention in large rooms (mutex profile); Redis client goroutines.
### 7.2 API (Node)
```bash
node --cpu-prof --cpu-prof-dir=$OUT/api/profiles apps/api/dist/main.js
npx clinic doctor -- node apps/api/dist/main.js     # event-loop delay, GC
npx clinic bubbleprof -- node apps/api/dist/main.js # async waits (Prisma, Redis)
```
Prisma query logging (perf build): `prisma.$on('query', e => log({q:e.query, ms:e.duration}))` → `api/prisma-queries.jsonl` → count per GraphQL op (N+1 when count ∝ result size).
### 7.3 Postgres / Redis
```sql
SELECT left(query,120), calls, mean_exec_time, rows FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25;
SELECT relname, n_tup_upd, n_dead_tup, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables ORDER BY n_tup_upd DESC;   -- snapshot table churn/bloat
```
`redis-cli info commandstats | grep -E 'publish|subscribe'`; `redis-cli client list | awk '{print $NF}'` → watch `omem` for slow pub/sub consumers.
### 7.4 Expected signatures
| Symptom | Evidence | Cause |
|---|---|---|
| Updates lost for some clients | log "send buffer full…", convergence false | 256 buffer + drop [src] |
| Handshake failures under storms | API p99 > 3 s | session verify timeout [src] |
| p99 fan-out ∝ room size | cpu: per-client writes | O(N) broadcast, payload copies |
| Edits lost on crash | PERS-02 | 10 s debounce [src] |
| GraphQL p99 ∝ list size | Prisma logs | N+1 resolvers |

## 8. Scripts
### 8.1 Multi-process edit-latency runner (Node, yjs + y-websocket)
```javascript
// node bench/perf-edits.mjs <docs> <clientsPerDoc> <editsPerSec> <seconds> <outCsv>
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import WebSocket from 'ws'; import fs from 'node:fs';
const [D,C,R,S,OUT]=[+process.argv[2],+process.argv[3],+process.argv[4],+process.argv[5],process.argv[6]];
const URL=process.env.SYNC_URL||'ws://localhost:1234'; const TOKEN=process.env.TOKEN; const rows=[]; const finals={};
const clients=[];
for(let d=0;d<D;d++) for(let c=0;c<C;c++){ const doc=new Y.Doc(); const name=`${process.env.DOC_PREFIX||'perf'}-${d}`;   // VERIFY room naming (documentId) and token param
  const p=new WebsocketProvider(URL,name,doc,{WebSocketPolyfill:WebSocket,params:{token:TOKEN}}); const log=doc.getArray('perflog');
  log.observe(e=>{ for(const it of e.changes.added) for(const v of it.content.getContent()) if(v.from!==`${d}-${c}`) rows.push(`${name},${v.from},${v.seq},${v.t},${d}-${c},${Date.now()}`); });
  clients.push({d,c,doc,p,log,name,seq:0}); }
await new Promise(r=>setTimeout(r,5000));     // let handshakes finish
const iv=setInterval(()=>{ for(const k of clients) if(Math.random()<R/10) k.log.push([{from:`${k.d}-${k.c}`,seq:k.seq++,t:Date.now()}]); },100);
setTimeout(()=>{ clearInterval(iv); setTimeout(()=>{
  for(const k of clients){ (finals[k.name] ||= []).push(Buffer.from(Y.encodeStateAsUpdate(k.doc)).toString('base64').length + ':' + k.log.length); }
  fs.writeFileSync(OUT,'doc,sender,seq,t_send,receiver,t_recv\n'+rows.join('\n'));
  const conv=Object.entries(finals).map(([doc,h])=>({doc,converged:new Set(h).size===1,hashes:h}));
  fs.writeFileSync(OUT.replace('.csv','-convergence.json'),JSON.stringify(conv)); process.exit(0); },5000); },S*1000);
```
Latency = `t_recv − t_send` (same host clock; for multi-host, use one host or NTP-synced with error noted). Percentiles: `python -c "import pandas as p;d=p.read_csv('edits.csv');print((d.t_recv-d.t_send).quantile([.5,.95,.99,.999]))"`. For > 5k clients, launch N processes with different `DOC_PREFIX` ranges and multiple source IPs. (Content-length + array-length is a cheap convergence proxy; for a strict check compare `Y.encodeStateVector` and decoded content.)
### 8.2 Harness sweep
```bash
for N in 10 50 200; do SYNC_URL=ws://localhost:1234 FANOUT_CLIENTS=$N FANOUT_ROUNDS=200 THROUGHPUT_SECONDS=30 SYNC_PID=$(pgrep -f apps/sync) node bench/sync-latency.mjs > $OUT/sync-latency-$N.txt; done
for D in 50 500 2000; do NUM_DOCS=$D CLIENTS_PER_DOC=10 SYNC_PID=$(pgrep -f apps/sync) node bench/sync-scale.mjs > $OUT/sync-scale-$D.txt; done
for C in 20 100 200; do CONCURRENCY=$C DURATION_SECONDS=60 API_PID=$(pgrep -f apps/api) node bench/api-throughput.mjs > $OUT/api-$C.txt; done
grep -H -oE 'p(50|95|99)=[0-9.]+ms' $OUT/*.txt | sed 's/ms$//' > $OUT/percentiles.tsv
```
### 8.3 Crash-window measurement (PERF-PERS-02)
Run 8.1 with sequence numbers; at t=30 s `kill -9` sync; restart; reconnect a fresh client to each doc; `lost = max_seq_sent − max_seq_present` per sender (only counts edits not held by any surviving client/instance). Repeat with `SNAPSHOT_DEBOUNCE_MS=1000`.

## 9. Scalability
Sync: CPU ≈ Σ_rooms (edit_rate × room_size) message writes ⇒ model cost per delivered message (µs) from PERF-SYNC-04; instances scale linearly only if docs are sharded by instance (sticky routing) — otherwise Redis traffic ∝ instances. Connections: RSS/conn × target concurrent users. API: replicas 1/2/4 USL.

## 10. Regression gates
benchstat MB-01..06 +10% ⇒ fail; `bench:all` at fixed params: fan-out p99 ≤ 1.2×, api req/s ≥ 0.9×; dropped_updates = 0 and converged = true always.

## 11. Report template
```
Run <date> sha <sha> | instances | SNAPSHOT_DEBOUNCE_MS | Go/Node | Redis/PG | client hosts/IPs
Sync: | scenario | docs×clients | edits/s | fan-out p50/p99/max | handshake p95 | dropped | converged | CPU | RSS | goroutines |
API: | op | conc | req/s | p50 | p99 | prisma queries/op |
Top CPU (sync, api); mutex hotspots; Redis pub/sub load; findings
```

## 12. Risks from source
| # | Risk | Scenario |
|---|---|---|
| R1 | Slow-consumer updates silently dropped (256 buffer) ⇒ divergence unless client resyncs | PERF-SLOW-01 |
| R2 | 10 s snapshot debounce ⇒ crash loses recent edits | PERF-PERS-02 |
| R3 | Session verify via API with 3 s timeout ⇒ reconnect storms fail | PERF-CONN-03/04 |
| R4 | No metrics endpoints in sync/api | §7.1 |
| R5 | Throttler 100/60 s affects naive API load tests | PERF-API-01 |
| R6 | 10 MB read limit per message — large pastes costly | PERF-SYNC-06 |
