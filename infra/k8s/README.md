# infra/k8s

Plain Kubernetes manifests (no Helm/Kustomize) for a namespaced deployment
of the full stack. See [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for
the broader picture (images, secrets, scaling behavior, health checks).
LiveKit (huddles) is not included here — see that doc's "Kubernetes"
section.

## Files, in apply order

| File | Kind | Notes |
|---|---|---|
| `00-namespace.yaml` | `Namespace` | Everything else lives in `custom-workspace` |
| `01-secrets.yaml` | `Secret` ×3 | **Template — every value is a placeholder.** Replace before applying; see the file's header comment |
| `02-postgres.yaml` | `StatefulSet` + `Service` | In-cluster Postgres. Use a managed database instead for real production and skip this file |
| `03-redis.yaml` | `Deployment` + `Service` | Single instance — sufficient for throttler storage / pub/sub fan-out here |
| `04-api.yaml` | `Deployment` + `Service` | Stateless, 2 replicas by default |
| `05-sync.yaml` | `Deployment` + `Service` | Session-affinity `Service` (per-room in-memory state) |
| `06-web.yaml` | `Deployment` + `Service` | Stateless static SPA |
| `07-ingress.yaml` | `Ingress` ×3 | Host-based routing for web/api/sync — no TLS block included, add per your controller |

## Before applying

1. **Images**: build and push `custom-workspace/api`, `custom-workspace/sync`,
   `custom-workspace/web` (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)
   "Images") and replace every `REPLACE-ME` image tag in `04-api.yaml`,
   `05-sync.yaml`, `06-web.yaml`.
2. **Secrets**: replace every placeholder value in `01-secrets.yaml` with
   real generated secrets (`openssl rand -hex 32`) or, better, your
   platform's secret-management mechanism instead of this plain template.
   `workspace-jwt-secret`'s `JWT_ACCESS_SECRET` **must** be byte-identical
   to what `04-api.yaml`/`05-sync.yaml` reference — they already point at
   the same `Secret` key, just don't fork the value.
3. **Hostnames**: replace `REPLACE-ME.example.com` in `07-ingress.yaml`
   with your real hostnames, and pass the matching URLs as `apps/web`'s
   `VITE_API_URL`/`VITE_WS_URL` **build args** when building the `web`
   image (they're baked in at build time, not runtime — see
   [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)).
4. **TLS**: add a `tls:` block + cert-manager annotations (or your
   controller's equivalent) to each `Ingress` — none is included here.
5. **Database**: either point `workspace-postgres-secret`'s `DATABASE_URL`
   at a managed Postgres and delete `02-postgres.yaml`, or keep
   `02-postgres.yaml` for a demo/staging cluster.

## Apply

```sh
kubectl apply -f infra/k8s/
```

Files are numbered so a plain `kubectl apply -f infra/k8s/` (which applies
in the directory's sorted filename order) creates dependencies (namespace,
secrets, postgres, redis) before the services that reference them. Then run
migrations against the in-cluster (or managed) Postgres before traffic
hits `api`/`sync`:

```sh
DATABASE_URL=<the same value as workspace-postgres-secret's DATABASE_URL> pnpm prisma:migrate
```

## Verifying

```sh
kubectl -n custom-workspace get pods
kubectl -n custom-workspace port-forward svc/api 4000:4000
curl localhost:4000/health
```
