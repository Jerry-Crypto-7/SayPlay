# Deploy log

Production deployments of the public demo (`demoUrl` in [submission.json](submission.json)). Each row is checked on the public address: `/api/health` returns `ready:true` and `durabilityVerified:true`, and `/api/build-id` returns the deployed git tree. The newest row marked **last good** is the one to roll back to.

| Date | Git tree (`/api/build-id`) | Source | Deployment ID | Spend book prefix | Status |
|---|---|---|---|---|---|
| 2026-11-07 | `6350ab7251635cde18f8b61f15029356fd4eef77` | `main` at 2554d28c | `dpl_HTZBbRdP4akLwR2zvwwjR74RNYRw` | `sayplay-trial` | last good |
