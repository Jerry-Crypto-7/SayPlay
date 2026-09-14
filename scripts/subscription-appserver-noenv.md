# Fixed app-server metadata bridge

Current helper profile v2 passed on the actual pinned CLI with the static catalog
and all 22 fixed configuration values set both before process startup and at
thread creation. `scratch/session8-appserver-metadata-summary-v4.json` is the
corrected index of that run: metadata completed in 239.96 ms, `model/list` returned
only `gpt-5.6-sol`, and eight observed pidfds, the namespace and owned unit/leaf
were cleaned. This is handshake latency, not inference latency.

Independent raw review found an automatic websocket startup attempt denied by
the OS with EPERM. The pinned CLI schedules prewarm before a turn; this helper
is not network-inert. No successful external connection or inference was observed.
The explicit network experiment remains NOT_RUN. Earlier summaries are retained;
the v4 index corrects the interpretation without claiming another runtime run.

The read-only catalog preserves the exact published model entry except
`tool_mode=direct` and `multi_agent_version=disabled`. Its hash and the helper hash
are bound before dispatch. The complete fixed profile also disables agents,
hosted image generation, goals, memories, plugins, orchestrator capabilities and
interactive requests. The unconditional `update_plan` bookkeeping utility remains.
`model/list` verifies sole-model selection, not the internal tool registry.
Production auth, egress, full OS generation transport and runtime registry remain
separate requirements; the default production launcher stays closed.

The following paragraphs retain earlier profile attempts and their narrower scope.

The newer actual run also passed after UTS isolation and explicit
`features.multi_agent:false` / `features.multi_agent_v2:false`:
`scratch/session8-appserver-metadata-summary-v2.json` (SHA-256
`92d63bf964d8a7685b9c53c0aa37cc1fde5375bf35c1d64d613399022d5c51cf`).
The actual CLI reports `reality-compiler-probe`, and metadata completed in
374.91 ms. The pinned CLI enables Collab by default outside the no-environment
handler branch. These two flags alone do not prove complete agent suppression:
further source review found model-catalog precedence, subsequently addressed by
the static catalog and full v2 policy above. This source finding
does not establish a filesystem escape.
Earlier metadata-only runs did not dispatch any turn and retain their original scope.

Actual metadata handshake now passed on the pinned ELF inside candidate systemd
limits: `scratch/session8-appserver-metadata-summary.json` records three separate
attempts (FAIL/FAIL/PASS). The second rejected the newly observed disabled remote
status; the third follows pinned-source compatibility and current-validator hash
binding fixes. It completed metadata in 343.54 ms, retained 1891 app-server bytes,
and verified nine pidfds ESRCH, empty namespace and removal of its own unit/leaf.
No turn, inference or authentication occurred. These runs precede UTS isolation;
the host hostname was visible, an explicit metadata-isolation limitation.

Only one `remoteControl/status/changed` with disabled status, null environment,
bounded server name and UUID installation ID is accepted after verified initialize.
Notifications may carry a safe nonnegative integer `emittedAtMs`. This adds no RPC.
Pinned source, not the thread reply, supports the no-environment registry claim;
runtime registry enforcement and production auth/network remain unvalidated.

This helper runs only inside the existing credential-free Linux capsule. It
accepts no command, environment, prompt, RPC or CLI argument from its caller.
The fixed argv is `/usr/bin/codex`, then 22 literal `-c key=value` pairs, then
`app-server --stdio`, verified against the pinned CLI argument parser. The process
policy is derived from the same fixed dictionary used for thread configuration.
Configuration isolation comes from the exclusive
HOME and outer capsule, not an unsupported command-line option.

The first actual attempt used `/usr/bin/codex --ignore-user-config app-server
--listen stdio://` and failed before initialize with exit2: unexpected root
`--ignore-user-config`. That failure is preserved in
`scratch/session8-systemd-cli-appserver-noenv-codex-cli-resource-7656fb1ef9224f068eb6343e3ec76c49.service.json`
(SHA-256 `03357ed481b55d6acf72ad5017fd3595a4bc1a38ca64c714a161d6f704dbb4e6`).
The complete failure transcript, six pidfd ESRCH and own unit/leaf cleanup were
verified. No auth/account/turn RPC ran. The replacement is an explicitly new
fixed argv from [pinned cli/src/main.rs](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/cli/src/main.rs#L515),
not a relabeling of that original FAIL.

The supervisor supplies writable `/work/appserver-home`. The helper creates a
new exclusive `fixed-*` directory there and a private tmp child; HOME/CODEX_HOME
point only at this fresh directory. Only fixed PATH, LANG and these three own
paths enter the environment. It does not inspect or reuse host auth/config files.
The outer capsule must independently enforce absence of host credentials/network.
This helper does not delete the directory or change host credentials.

Wire uses JSONL without `jsonrpc`: initialize ID1, wait for its response,
initialized notification, thread/start ID2, then model/list ID3 with includeHidden.
Success requires one exact model and no pagination cursor after an actually
written model/list request. ClientInfo version is the string `1`.
The thread requests gpt-5.6-sol/openai/low, provider fallback disabled, no
environments, dynamic tools, capability roots or runtime workspace roots,
read-only/never approvals, ephemeral, shell/apps disabled and web search disabled.
There is no account/auth request, turn/start, tool response, inference, or automatic
recovery RPC. Duplicate/out-of-order responses, server requests and unknown
notifications fail closed. Only `thread/started` is accepted and archived after
the thread request has actually been written. Notifications remain bounded opaque
metadata; they never cause a reactive request.

Initialize response must identify the exact fresh CODEX_HOME and Linux/unix.
Thread response must preserve model/provider/effort, cwd, approval policy, empty
runtime workspace roots and sandbox `{type:readOnly,networkAccess:false}`, with
`thread.ephemeral=true` and `thread.path=null`. It does **not** echo environments;
the helper therefore always reports `runtimeRegistryValidated:false` and
`productionReady:false`. Empty environments are a requested no-environment seam,
not proof that every internal tool is unregistered. PlanHandler may still exist.

Metadata has a cumulative 12-second deadline. `metadataCompletedMs` is measured
after complete response parsing and profile validation, including select/read
delays; values >=12000 never receive success credit. Incomplete/not-started
metadata uses null. Offline replay requires a finite numeric, nonboolean value
strictly below 12000 and no later than total elapsed time (0.5ms rounding margin).
Control writes also recheck the deadline immediately before dispatch.
Output is nonblocking with a
128-KiB combined stdout/stderr cap; serialized control is capped at 4 KiB. Partial
writes are accounted, and a response cannot precede the complete request write.
EOF starts the direct-child cleanup schedule: TERM after 2s, KILL at least 5s
after the TERM send returns, stop 1s after KILL returns. Scheduler delays cannot
skip TERM, reorder signals, or shorten the actual TERM grace. A 22-second outer
helper bound stops with unknown cleanup rather than sending KILL before grace.
Only the pinned pidfd is signaled. All poll/reap waits are bounded; exceptions
preserve this bounded grace sequence. A pin failure has no numeric-PID kill
fallback and receives no cleanup credit. Descendant cleanup remains the outer
supervisor's independent responsibility. A descendant retaining stdout can prevent
complete EOF credit even after the direct child exits.

Report archives queued and delivered requests, allowed responses, protocol
errors, cleanup history and bounded raw stdout/stderr as base64. After output
overflow, retained raw is explicitly incomplete; observed bytes continue counting
while draining within the cleanup budget. `credentialFilesRead:false` describes
the helper, which does not read credential files; it is not an attestation about
every internal app-server open attempt against its newly empty HOME.

`validate_report(report)` provides offline transcript replay: it reconstructs the
fixed Protocol, checks queued/written/received order with strict JSON types,
matches raw stdout lines against received frames, verifies byte accounting,
required profile fields and direct-child/EOF evidence. It never substitutes for
the supervisor's independent image-binding and descendant cleanup validation.

Pinned schema provenance from independent source review: Codex rust-v0.145.0,
commit `25af12f7e61572b0bc18ddb1008be543b91519b0`, protocol `v1.rs`,
`v2/thread.rs`, and `v2/permissions.rs`. Source tag identity does not by itself
establish a reproducible mapping to the pinned CLI binary. No runtime, auth,
network or inference run was performed by the helper implementation worker.
