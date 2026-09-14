# Fixed executor environment metadata parent

This separate trusted parent connects the actual app-server environment client
to the fixed stdio executor metadata gate. It accepts no caller requests, paths,
arguments or environment overrides. The old no-environment metadata profile and
the historical direct executor probe keep their own evidence and source hashes.

The supervisor mode is `exec-environment-metadata`, with direct
`/usr/bin/python3 -I -S /usr/bin/exec-environment-metadata-parent.py` and no extra
arguments. The ready boundary binds exactly seven helpers: gate, trampoline,
probe, lockdown, noenv policy, pinned catalog and this parent. Both the parent
report and the outer measurement must bind current helper hashes; hashes supplied
inside a report are not independently authenticated evidence.

The parent exclusively creates `/work/environment-appserver-home`, its tmp
directory and the exact `environments.toml` literal. `include_local=false`, the
single `fixed-worker` default, fixed Python/gate argv and `/work` cwd admit no
local fallback, URL or inherited caller configuration. The gate independently
owns `/work/executor-home`; the parent never creates it or reads its auth/config.
Its only read there is the bounded, regular-file, no-follow, nonblocking metadata
trace. Missing or incomplete trace is a failure, not a fabricated reply or retry.

All 22 historical policy values remain fixed, with `features.shell_snapshot=false`
and `project_doc_max_bytes=0` added before process manager creation and in thread
configuration (24 fixed values). The latter supported setting returns before
project AGENTS.md path discovery or remote filesystem calls in pinned
`core/src/agents_md.rs`; it does not authorize a filesystem RPC.
This is a material follow-up to the preserved first environment metadata FAIL,
not a relabeling of that run. The pinned
catalog digest is checked before spawning. The parent uses a clean five-variable
environment, retaining the existing credential-free outer capsule restrictions.
It intentionally does not install worker lockdown on the trusted app-server:
the separate gate rejects process/fs/HTTP/auth RPCs in this metadata profile.

Only app-server initialize, initialized and thread/start are sent. Thread/start
selects exactly `fixed-worker`, environment cwd `/work/exec-worker` and its single
workspace root. The top-level cwd remains `/work`; the actual reply must contain
`runtimeWorkspaceRoots:["/work/exec-worker"]`, the pinned model/provider/low effort,
read-only/no-network sandbox and an ephemeral thread. The scoped reply validator
preserves the actual frame; it never substitutes the historical empty roots.
No model/list, turn or generated content is requested.

The reused noenv Capture and Cleanup helpers retain bounded raw stdout/stderr and
the EOF 2s → TERM 5s → KILL 1s direct-child schedule. Metadata completion is bounded
to 12 seconds, total parent operation to 22 seconds. Exceptional paths report
unknown direct cleanup honestly and rely on the outer supervisor as the separate
descendant cleanup authority. The original outer 180/200/5-second and 8 MiB limits
remain independent. Thread success alone does not establish environment-hook
success or a complete runtime tool registry.

`environmentHook` preserves the exact bytes/hash of the gate's bounded trace file
and its parsed report. Gate history records actual parsed responses and requests
after full OS write. This is **not** the original JSONL whitespace/byte transcript
of that inner connection. `validate_report(report, policy, gate)` replays both
the app-server wire/history and the gate's strict initialize/environment-info
snapshot. The atomic `phase:protocol-complete` snapshot retains
`localReturnCode:null`: app-server connection Drop may send TERM before the gate's
finally block. This snapshot grants protocol credit only. An optional, separate
terminal trace is archived and replayed when observed; a known terminal failure
cannot be hidden, and malformed known terminal bytes never become an absent
terminal. `environmentHook.terminal:null` means terminal not observed, with local
gate cleanup unknown. The parent's own app-server exit and the outer namespace
cleanup remain separate checks. The gate trace is trusted local evidence,
not kernel attestation; outer namespace cleanup must be validated separately.
The separate terminal now carries `rejectedRequest`: success requires null.
Known refused-request structural projections remain raw/typed failure evidence
and are not appended to actual-written history. No rejected filesystem request
is authorized by recording it. The first metadata FAIL's app-server SIGTERM
does not change this parent's exit-zero acceptance: pinned EOF shutdown drains
connection cleanup/background tasks/threads, but the particular delayed await
was not measured. Project-doc disable is the supported pre-dispatch correction;
there is no new permissive exit or arbitrary shutdown RPC.
Shell/cwd/networkProxyLaunch fields are retained metadata, never permission to
launch a shell or network proxy. Known sandbox advisories are preserved exactly
once after initialize and never grant readiness or bypass a gate.

Source contract: OpenAI Codex commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`, archived handoff at
`scratch/session8-executor-environment-integration-handoff.md`. The supported
TOML and selector are from environment_toml.rs and v2/turn.rs; reply workspace
roots derive from the first selected environment in session/session.rs, while
legacy fallback cwd remains the top-level cwd. Startup can initialize the gate
before thread selection. Additional discovery RPCs remain a preserved refusal.

Offline tests are authored fixtures and grant no actual client-hook, auth,
inference, network, aggregate resource or production readiness credit. Initial
test attempts hit Windows pytest temporary-directory ACL failures; an independent
home-ordering mock avoids those fixture filesystem operations without claiming
Linux permission validation. A Windows path-spelling assertion was corrected.
No temporary ACL was bypassed and no historical evidence was removed.

## Separate bootstrap metadata profile

The only additive CLI selector is `--bootstrap-metadata`; no arguments continue
to select the historical metadata-only profile. The new supervisor mode is
`exec-environment-bootstrap-metadata`, invoking the same readonly parent with
that exact selector. Its report profile is
`fixed-exec-environment-bootstrap-metadata-parent`, validated exclusively by
`validate_bootstrap_report(report, policy, gate)`. The old validator rejects this
profile and the new validator rejects old metadata reports. Both retain the same
seven helper identities, clean HOME ownership, 12-second app-server metadata
completion and 22-second total parent budget, raw accounting and exit-zero
acceptance. No previous FAIL receives credit from this new profile.

Bootstrap configuration adds the fixed `project_root_markers=[]` to the existing
24 values in both process argv and thread config. Its TOML uses the single fixed
gate selector `--environment-bootstrap-metadata`. The parent still sends only
initialize, initialized and thread/start; it does not synthesize an inner stat
request or response. The actual app-server client must issue one `fs/getMetadata`
for each of exactly `file:///work/.agents/skills` and
`file:///work/exec-worker/.agents/skills`, with `sandbox:null`, through the
separately reviewed bootstrap gate. Either order is accepted, with only one
request outstanding and no duplicate path. The gate checks both `/work/.agents`
and `/work/exec-worker/.agents` with lstat before spawning its stock executor and
requires ENOENT without creating either directory or file. Each accepted actual executor response is error code
`-32004` with its bounded message and **omitted** data field. Success, another
path, a content-reading method, repeated stat, another error or `data:null` fails.
These two explicit metadata operations are not permission for general filesystem
access, authentication or content reads.

Bootstrap snapshots and optional terminal reports use only
`/work/executor-home/environment-bootstrap-metadata-trace.json` and
`environment-bootstrap-metadata-terminal.json`. The separate gate validator
requires actual initialize/info plus both stat requests/responses before protocol
completion. Their raw file bytes and typed histories remain distinct from the
app-server stdout transcript. A known terminal failure still fails the parent;
an absent terminal stays unknown and grants no cleanup credit. Missing trace or
extra upstream discovery remains a preserved failure, never fallback to the old
profile or fake metadata. Shared gate/supervisor integration and actual runtime
require their own source freeze and review.

For bootstrap only, a thread reply does not close app-server stdin. The parent
continues draining stdout/stderr and polling the fixed atomic snapshot while the
app-server is alive, within the original 12-second deadline. A missing snapshot
is pending; a known terminal is checked independently even when the snapshot is
missing, and malformed or failed evidence fails immediately. The gate's required
`completionEvidence:"client-pipe-written-not-acknowledged"` records complete
actual client-pipe writes of both responses, not receipt acknowledgement.
Only a valid completed snapshot plus a fresh live-child observation permits EOF.
`bootstrapHookBeforeEof` binds its raw SHA-256, child PID and unrounded shared
clock sample to final evidence; `metadataCompletedMs` uses that same sample.
This is a point-in-time observation, not durable liveness or descendant cleanup.
The later snapshot must retain the same hash, and normal direct-child exit-zero
and independent outer cleanup requirements remain unchanged.

Offline regression includes the event-loop ordering (drain while the snapshot is
pending, then completed snapshot before EOF), terminal-without-snapshot failure,
dead child/deadline rejection, cross-profile replay and both-stat completeness.
The first new test run preserved 95 PASS / 1 FAIL: a test compared IEEE-754
`1.00049 * 1000` with a differently rounded literal. The expected value was fixed
to use the same arithmetic; runtime timing or acceptance limits were unchanged.

## Separate controlled bootstrap cleanup

`--bootstrap-controlled-cleanup` selects report profile
`fixed-exec-environment-bootstrap-controlled-parent` and only
`validate_controlled_bootstrap_report(report, policy, gate)` accepts it. It reuses
the same bootstrap two-stat gate, 25 fixed config values, TOML, metadata proof and
12/22-second limits. Both historical selectors retain exit-zero acceptance.
The earlier natural-cleanup FAIL is unchanged.

The pinned shutdown review records that EOF can await several asynchronous
shutdown stages; it does not identify which stage delayed the observed process.
This new profile declares bounded owned termination, not successful natural exit
by assumption. `cleanupOutcome` is either `natural-exit-zero` with no signal sent,
or `owned-pidfd-term`: actual successful SIGTERM delivery through the parent's own
pinned pidfd at least two seconds after EOF, followed by reaping that same child
with exit code -15. `signalDelivery` binds PID, signal, pinned status and unrounded
EOF/send times to the cleanup history. It is written only after the pidfd send
returns successfully; ESRCH does not produce delivery evidence. This proves a
send, not a signal-handler acknowledgement. A natural-zero/signal race is rejected.

Unknown or external signal termination, -9, missing pin/reap, failed metadata,
changed trace, incomplete output and known terminal errors still fail. Outer
descendant/namespace/resource cleanup must be verified independently by the
supervisor and measurement; this classification does not grant that credit.
Offline tests include runtime-loop simulation of natural exit, successful own
pidfd TERM and ESRCH, plus replay negatives for identity, timing and termination.
123 PASS are recorded in `scratch/session8-bootstrap-controlled-parent-unit-v2.xml`.
No actual controlled-profile run has been performed by this implementation step.
