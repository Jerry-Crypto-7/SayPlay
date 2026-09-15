# Fixed capsule measurement integration

Additional explicit profiles are `exec-environment-bootstrap-metadata` and
`exec-environment-bootstrap-controlled`. Both require the two exact bootstrap
metadata/ENOENT exchanges and a live pre-EOF gate snapshot. The latter alone
selects `validate_controlled_bootstrap_report`: it accepts classified natural
zero or own pidfd TERM sent at least two seconds after EOF with pinned reap −15.
The parent still exits zero only if its selected validator passes, and the outer
full transcript/cleanup checks below remain required. The original natural-exit
FAIL is never reclassified by choosing the new profile.

The current capsule inventory has 19 source files, including the two trusted
control helpers copied into the shared image. This basic driver does not expose
the trusted-control experiment; its dedicated wrapper must validate that report
against the independently received supervisor ready facts.

`python -B scripts/subscription-cli-supervisor.measure.py exec-environment-metadata` is one additional fixed noninteractive scenario. It uses the existing WSL clean-env capsule command, inner200/5s timeout, source-before/after inventory, bounded queues/heartbeat and unique session8 artifact. No new command/environment/RPC injection is accepted. Runtime remains separately gated by source review.

The ready field `execEnvironmentMetadataBoundary.helperSha256` must contain exactly seven helpers: gate, trampoline, worker probe, lockdown, noenv policy, catalog, and metadata parent. `environment_start` validates the exact map against frozen source hashes before sending only `{type:'start',mode:'exec-environment-metadata',helperSha256}`. Duplicate ready is rejected before another start write.

`environment_evaluation` verifies current bytes for all seven helpers before importing anything, compiles exactly the verified parent/policy/gate bytes and calls the pure parent `validate_report(body,policy,gate)`. Parent before/after helper maps must match the frozen ready map. It accepts at most2MiB of stdout report serialization, rejects child stderr, invalid encoding, malformed/partial JSON and duplicate JSON keys. Parent raw inner stderr remains bounded evidence inside its report and is not confused with supervisor child stderr.

The full scenario requires one matching started frame and one selected terminal, reason EXITED, child0/wrapper0, no wrapper stderr, exact stdout/stderr EOF, no registry/output overflow, verified empty namespace, observed pidfds and ESRCH with no signal failures. Output bytecount/hash is independently recomputed from actual decoded frames instead of trusting a supplied transcriptIntegrity flag. Fixture metadata claims alone cannot supply these cleanup facts. No auth, inference, environment-hook runtime success or aggregate resource exhaustion is credited by offline tests.

Source inventory includes every current copied Python/catalog helper, metadata-pipe child, new metadata parent, and this measurement validator. Historical manifests/checkpoints remain historical; every new run records fresh before/after hashes. ELF runtime identities remain the supervisor's independently pinned fields, not hashes of source files.

Scoped validation:20 measure tests pass with a real replay of the independent parent fixture plus missing/foreign/malformed/spoofed helper binding, partial/raw/mode/terminal/cleanup/source drift negatives; unchanged UTS/appserver source-binding tests remain. Combined gate78+measure20 gives98 PASS in the final scoped run. No actual capsule was launched by this implementation task.
