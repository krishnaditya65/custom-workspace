# Custom Workspace test report

Date: 2026-10-04 (Asia/Kolkata)

## Scope

This pass covers isolated web-client behavior, API service authorization and
data-shaping logic, and the existing Go sync-relay unit tests. New test files
are kept under `tests/`; the web runner configuration is
`apps/web/vitest.deeper.config.ts`.

No Docker containers or external services were started. In particular,
Postgres, Redis, and LiveKit from `infra/docker-compose.yml` were not started.

## Tests added

### Web client (`tests/web`)

- `gain.deeper.spec.ts` tests Euclidean distance, symmetry, degenerate radius
  cutoffs, and exact near/far boundaries for both falloff curves.
- `api-client.deeper.spec.ts` tests authorization headers, GraphQL variables,
  HTTP 401 refresh and retry, concurrent refresh deduplication, and surfaced
  GraphQL errors.

### API services (`tests/api`)

`services.deeper.spec.ts` uses mocked Prisma and pub/sub boundaries, without a
live database or Redis. It covers:

- Channel parent/child tree construction and archived-channel filtering.
- Cross-workspace parent rejection and idempotent channel archival.
- Task assignee membership enforcement and status updates after authorization.
- Message cursor pagination and chronological result ordering.
- Message edit authorization and idempotent soft deletion.

## Results

| Suite | Command | Result |
| --- | --- | --- |
| New web tests | `pnpm exec vitest run --config vitest.deeper.config.ts` from `apps/web` | 8 passed |
| New API service tests | `pnpm exec jest --config ../../tests/api/jest.config.ts --runInBand` from `apps/api` | 8 passed |
| Existing web unit tests | `pnpm test` | 13 passed |
| Existing API unit tests | `pnpm test` | 31 passed |
| Go sync unit tests | `go test ./...` from `apps/sync` | All test-bearing packages passed |
| Go race check | `go test -race ./...` from `apps/sync` | All test-bearing packages passed; no race reports |

The web and API application unit suites ran through the repository's normal
`pnpm test` command. The new tests are intentionally invoked separately so
they can remain in the top-level `tests/` folder without changing the
application source test discovery rules.

## Infrastructure and untested layers

- No external infrastructure was used for this pass.
- `apps/api/test/app.e2e-spec.ts` remains a real GraphQL/Postgres/Redis E2E
  suite and was not run.
- `bench/verify-sync.mjs` remains a real-client relay/persistence check and
  was not run; it needs Postgres, the sync process, and the Yjs client bench.
- `bench/` performance scripts were not run because they are measurements,
  not correctness tests, and may require running services.

Those heavier commands require explicit approval before starting
`pnpm dev:infra` or other service processes.
