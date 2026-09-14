# Fixed exec-server worker gate

## Additive trusted ingress profile

`--trusted-ingress-boundary` and zero-argument `ingress_start_request()` select
only the fixed new ingress worker probe and trampoline selector, exact readonly
`/work/trusted-ingress-boundary.json` rule and unchanged app-server HOME denial.
Metadata-only marker admission precedes stock executor spawn. Cross-profile
requests, marker writes, caller environment or FD arguments fail closed. The
trampoline preserves fresh-proc/readonly checks and synchronous lockdown, closes
all nonstandard FDs including198, then execs only the new probe with the existing
four-variable environment. Old selectors remain unchanged; gate subprocesses
retain close_fds=True with no ingress pass_fds.

This is an executable stdio bridge for one authored, credential-free worker probe. It launches the pinned CLI's real `exec-server`, forwards only admitted process protocol requests, and replaces the fixed probe argv with a readonly post-sandbox trampoline. It is not an authenticated dispatcher or a complete CLI environment implementation. The supported `environments.toml` stdio program hook has been identified in source but has **not been run**; the first integration uses the existing fixed supervisor and its clean environment directly.

## Fixed integration contract

Run `/usr/bin/python3 -I -S /usr/bin/exec-server-worker-gate.py --inside` only inside the existing credential-free outer capsule. Do not apply the worker namespace filter to the gate or exec-server before their sandbox setup. The trusted launcher must clear its environment before Python starts; Python code cannot undo a previously inherited `LD_PRELOAD`.

The readonly image must contain these six source-bound helpers:

| Source | Image path |
| --- | --- |
| subscription-exec-server-worker-gate.py | /usr/bin/exec-server-worker-gate.py |
| subscription-exec-server-worker-trampoline.py | /usr/bin/exec-server-worker-trampoline.py |
| subscription-worker-lockdown.py | /usr/bin/worker-lockdown.py |
| subscription-exec-worker-probe.py | /usr/bin/exec-worker-probe.py |
| subscription-appserver-noenv.py | /usr/bin/appserver-noenv.py |
| subscription-text-model-catalog.json | /usr/bin/text-model-catalog.json |

The gate exclusively creates `/work/executor-home` (trusted HOME/CODEX_HOME), its tmp and authored sentinel, plus `/work/exec-worker` and its tmp. They must not be precreated. It reuses the immutable noenv policy argv, replacing only `app-server --stdio` with `exec-server --listen stdio`; its 22 policy/catalog overrides remain. No login, account, auth, HTTP, filesystem or inference RPC is admitted.

Offline imports have no runtime side effects. Exports `initialize_request()`, `start_request()`, `read_request(id, after_seq=None)`, `terminate_request(id)` and `fixed_sandbox()` construct the exact allowlist. `Gate` is the parser/admission state; `run_gate` is the actual nonblocking OS pipe transport.

Wire is pinned exec-server JSONL **without** `jsonrpc`. Initialize id 1 uses clientName `reality_compiler_executor` and null resumeSessionId; its response requires a sessionId. Then send exactly `{"method":"initialized","params":{}}`, followed by fixed start id 2. Only increasing integer request IDs up to 128, own process `fixed-worker`, read (65536 bytes/1000 ms) and terminate follow. No second start or caller command is accepted. Initialized and start may be coalesced, but each state transition waits for the complete actual write; partial writes and EAGAIN cannot grant response admission. Supervisor input ACK proves delivery to this bridge, not to exec-server.

Read cursors are exclusive: pinned local_process filters `seq > afterSeq` and returns `nextSeq` one beyond the retained cursor, so continuation uses `nextSeq - 1`. Repeated null cursors replay retained chunks and require exact deduplication in the driver. Raw stdout/stderr remain separate and unchanged, except stderr may additionally contain the gate's fixed `EXEC_WORKER_GATE_DIAGNOSTIC` marker. These markers are included in the outer supervisor's output accounting.

## Worker boundary

The fixed filesystem policy denies `/` by default, allows readonly runtime helpers and proc, permits only the worker directory for writing, and explicitly denies `/private` and trusted executor HOME. Network is restricted. Caller env/envPolicy, sandbox, argv, managed proxy, tty and stdin cannot override the exact request. The gate supplies fixed worker environment and trusted outer namespace identities.

After stock exec-server sandbox setup, the trampoline requires new PID and mount namespaces and `/proc/1/ns/pid == /proc/self/ns/pid`. This rejects the pinned sandbox's inherited-proc fallback; unreadable namespace metadata fails closed. It then verifies the readonly helper image, installs the existing lockdown, closes nonstandard descriptors, and execs only the readonly probe with PATH/LANG/HOME/TMPDIR. Namespace marker variables and CODEX_HOME do not reach the probe. These are scoped invariants, not an assertion of an authenticated control partition or arbitrary hostile-code resistance.

The gate bounds input at 64 KiB, lines at 128 KiB, each output queue at 256 KiB and observed stdout+stderr at 8 MiB. Job 180 s and EOF 2 s → actual TERM grace 5 s → KILL wait 1 s are bounded locally; cleanup hard cap is 12 s. Outer command 200/5 s and capsule pidfd cleanup remain authoritative. Process notifications, local exit, or a killed bridge alone never prove descendant cleanup. This basic seam has no aggregate-resource exhaustion credit.

## Validation and source evidence

Scoped offline gate/trampoline tests initially passed 49 cases. Independent review then identified that PID namespace inequality alone permits an inherited proc mount. The strict PID-1 view check and its denied/fallback regressions bring the suite to **51 PASS**. Mocked OS pipe tests prove admission and raw-byte behavior, not a kernel sandbox or real exec-server success. Actual execution remains subject to separate source review and capsule measurement.

Pinned source commit: `25af12f7e61572b0bc18ddb1008be543b91519b0`. Public source receipts are in `scratch/session8-worker-executor-source/receipt*.json`; the discovery rationale is `scratch/session8-next-auth-implementation.md`. Relevant primary modules are exec-server protocol `protocol.rs`/`rpc.rs`, `process_sandbox.rs`, `local_process.rs`, `environment_toml.rs`, `client_transport.rs`, file-system `lib.rs`, and linux-sandbox `linux_run_main.rs`. Source metadata does not establish a reproducible source-to-binary mapping.

## Additive environment-metadata profile (after direct-probe checkpoint)

`--environment-metadata` selects a separate fixed profile in the same OS pipe loop. `--inside` retains the direct probe contract above. This profile admits initialize id1 with clientName `codex-environment` and null resumeSessionId, initialized `{}`, then only `environment/info` with null params and consecutive integer IDs up to128. No process, filesystem, HTTP, auth or unknown method is forwarded. Optional request `trace` admits only the exact keys traceparent/tracestate with printable ASCII string values1–512 bytes, preserved unchanged; this is bounded metadata validation, not full W3C semantics or authorization. It is not accepted on notifications or in the direct profile.

The info response must have exact shell{name,path}, cwd and capabilities keys. Shell is bash/sh at its matching `/bin/` or `/usr/bin/` path, cwd `file:///work`, capability networkProxyLaunch is an actual boolean. A true advertised capability does not authorize any proxy/network RPC. Shell metadata does not prove that the executable exists or was run. No environment variable map is admitted. Response admission still requires complete actual request writes; coalesced initialized/info is supported with the same queue bookkeeping.

Normal metadata EOF can complete after admitted info without a process/closed event. The gate records actual-write requests and validated responses in bounded canonical history (24576 bytes). After the first fully admitted actual info response it atomically publishes `/work/executor-home/environment-metadata-trace.json` (32768 byte maximum) via an exclusive same-directory temporary file and no-overwrite hard link. Exact report keys: version1, profile, phase=`protocol-complete`, history entries `{direction,frame}`, complete=true, error=null, localReturnCode=null, modelCalls0, productionReadyfalse and remoteCleanup=`not-attested-by-gate`. This acknowledges validated protocol metadata, not client delivery, local process exit or cleanup. The parent must separately obtain its real selected-thread reply and outer supervisor cleanup. These files are canonical report bytes, not original JSONL byte transcripts.

A separate immutable `/work/executor-home/environment-metadata-terminal.json` has phase=`terminal`. The first known protocol/runtime error is published immediately before cleanup; successful/unknown local termination is published in finally if no earlier error report exists. It never overwrites the protocol snapshot. Missing terminal means unknown local termination, allowed only for scoped protocol credit with independent parent/outer proofs. A present failed, incomplete, nonzero or unknown terminal causes validation failure; it cannot silently disappear behind an earlier successful snapshot. Abrupt termination may prevent any final file, and no filesystem publication proves durable recorder receipt.

`environment_initialize_request()`, `environment_info_request(id)` and `validate_environment_metadata_report(snapshot, terminal=None)` are import-safe APIs. The validator replays exact bounded request/response order. If terminal is present, it additionally requires localexit0/noerror and snapshot history as a prefix of terminal history. It does not attest source provenance, client pipe receipt or process cleanup by itself. The parent must bind current helper hashes and preserve separate outer evidence; malformed known terminal must not be converted to missing terminal.

Initial tests for this addition hit pytest temp-directory ACL errors (60 PASS/4 fixture setup errors); a workspace temp retry hit the same ACL restriction. Narrow approved execution exposed one test-only failure: patching HOME for metadata report storage also changed the direct fixture's expected sandbox. Restricting that patch to metadata cases restored64 PASS. Subsequent replay-negative coverage is validated separately. These attempts are not relabelled runtime evidence. The historical direct-probe actual checkpoint predates this addition; actual environments.toml hook validation is still pending.

Independent pinned lifecycle review then established that the app-server connection drops its stdio child with process-group TERM and a2s grace (`scratch/session8-exec-environment-connection.raw.rs`, SHA75abb37b7b0a1064bb4a1a0d0bb476304ababc02062902ace07cff2cf3b87aa8). Default Python TERM need not run finally. The initial finally-only trace was therefore replaced before any hook runtime with the atomic protocol snapshot above. Combined gate78 + measure20 scoped tests pass98 cases, including actual mocked-loop late refusal, atomic no-overwrite and failed-terminal rejection. No production180/200/5 limits were changed; upstream group2s is reported separately, never labelled our5s cleanup guarantee.

## Rejected-request evidence after first actual hook attempt

The first actual hook attempt remains FAIL: `scratch/session8-cli-exec-environment-metadata-measure-63d5ab9e-eb8b-4b5e-9e7d-62a0c462baec.json`. Its actual initialize/info completed; a later gate PROTOCOL_REFUSED was correlated with app-server AGENTS.md lookup stderr. The original report did not retain the rejected request, so its exact method is not asserted retrospectively.

Terminal reports now add `rejectedRequest:null|projection`. This is the first **received, parsed, rejected** client frame; it is never appended to actual-written history and does not imply forwarding. The projection contains canonical serialized bytecount/SHA256, fixed validation code, numeric bounded ID, a method only if it belongs to the pinned public protocol vocabulary, known parameter key names, a count of omitted unknown keys, and only exact authored public path literals such as `/work/exec-worker/AGENTS.md`. Arbitrary values, environment/header/body contents, unknown method/ID strings, unknown key names and private paths are always omitted. `frameBodyOmitted:true` is mandatory. Canonical SHA is not the original JSONL byte hash. The method vocabulary is for diagnostics only and adds no permitted RPC.

`validate_rejected_request_evidence` checks the exact projection schema. Successful present-terminal validation requires rejectedRequest=null; any known rejected request prevents success. Protocol snapshots keep their previous schema and bytes. The report's existing32KiB cap still applies. Input has the existing bounds; even a60KiB rejected body produces a projection under1KiB, without retaining its content.

Scoped gate validation now passes89 tests. First attempt was88 PASS/1 FAIL because the new fixture sent id3 before completing id2, correctly producing EXEC_REQUEST_ENVELOPE instead of the test's expected EXEC_REQUEST_REFUSED. The fixture now completes actual info admission before rejected id3; no production rule changed. Negatives cover malformed projected fields, unknown/auth-like sensitive strings, omitted body values, and large input. No additional hook runtime was run by this change.

## Explicit finite bootstrap metadata profile

`--environment-bootstrap-metadata` is an additive fixed profile. The historical
`--environment-metadata` remains no-filesystem-RPC. After the actual initialize,
initialized and environment/info exchange, only one `fs/getMetadata` request is
admitted, with exactly `path: file:///work/.agents/skills` and `sandbox: null`.
The profile admits no process, HTTP, auth, other filesystem path or second stat.
Before spawning the stock exec-server, `lstat('/work/.agents')` must report absence;
an existing file, directory, symlink or another lookup error fails closed. The
fresh authored workspace and trusted controller remain prerequisites; this is
not an atomic guarantee against a concurrent privileged filesystem writer.

Completion requires the stat request to have been fully written and the real
server reply to have `error.code == -32004`, a nonempty UTF-8 message of at most
2048 bytes, and no `data` member. Success replies and other errors fail closed.
No ENOENT is fabricated and no response is rewritten. Accepted bounded trace
fields and the actual parsed reply remain in the history; the wire loop forwards
the original response bytes. The history is parsed wire evidence, not the original
JSONL byte representation.

The profile and trace files are distinct: `environment-bootstrap-metadata`,
`/work/executor-home/environment-bootstrap-metadata-trace.json` and the matching
`environment-bootstrap-metadata-terminal.json`. The export
`validate_environment_bootstrap_metadata_report(snapshot, terminal=None)` replays
this profile. The old validator rejects it. Snapshot publication waits for the
actual ENOENT response; a known later failure still invalidates a present terminal.
A missing terminal provides no cleanup credit. Parent selected-thread evidence and
outer supervisor cleanup are still independently required.

Validation: 112 scoped offline tests passed. The first attempt was 111 passed /
1 failed because a new positive test reused an intentionally failed protocol
instance after testing response-before-write rejection. The test now uses a fresh
instance; production fail-closed behavior was preserved. Coverage includes actual
mocked partial writes and original ENOENT bytes, one-shot/path/order restrictions,
strict reply shape, missing stat/cross-profile replay, and pre-spawn lstat denial.
No kernel, CLI, environment-hook or authentication execution was performed for
this source change. Prior actual failures remain historical failures.

### Two-path bootstrap revision after the first actual failure

The preceding one-path profile describes the historical source
`23c2cb1c9da35623759716c65afdac6c6fb66a5b3b07c1d187c487e8a0395a90`.
Its actual attempt `dc1431e2` remains FAIL: the first stat completed, then the
selected environment prewarm requested the second path. The source walk in
`scratch/session8-environment-bootstrap-prewarm-review.md` establishes these two
fixed requests. This revision permits exactly `file:///work/.agents/skills` and
`file:///work/exec-worker/.agents/skills`, once each, in either order with only one
outstanding request. Both real ENOENT replies are required for completion.
`lstat` must establish absence of both `.agents` parents after the authored worker
workdir is prepared and before the exec-server is spawned. All other paths and
content/process/HTTP/auth operations remain refused.

Only this bootstrap profile publishes its completion snapshot after the complete
response output queue has actually been written to the client stdout pipe, with
no error, pending request, awaiting reply, or partial server frame. Its explicit
`completionEvidence` is `client-pipe-written-not-acknowledged`; incomplete terminal
reports use null. This proves pipe writes, not client parsing, an application ACK,
or durable archival. The parent must wait for this snapshot while its app-server
is alive, within its existing budget. The historical noFS profile retains its
response-observed snapshot semantics. Known later errors remain separate terminal
evidence and invalidate validation.

117 scoped offline tests pass, including both request orders, missing/duplicate
paths, second-parent symlink refusal before spawn, unexpected response identity,
and a real mocked loop whose final response write is partial then raises EAGAIN.
That test verifies no snapshot exists while either write is incomplete and checks
the exact forwarded bytes at publication. No new actual runtime was performed by
this implementation task and no prior FAIL was relabeled.

## Fixed trusted-control probe profile

`--trusted-control-boundary` adds a direct process profile, with the existing
`reality_compiler_executor` initialize and fixed initialized notification. The
zero-argument `control_start_request()` export returns the only admitted start
request (id 2, process id `fixed-worker`). It requests the readonly
`/usr/bin/trusted-control-boundary-probe.py`; the gate rewrites it to the existing
readonly `exec-server-worker-trampoline.py --trusted-control-boundary` using
Python `-I -S`. The no-argument trampoline and old direct request are unchanged.
The fixed selector changes only the final readonly probe after all existing
private PID/proc/mount, readonly image, lockdown and FD closure checks.

The sandbox is the old fixed sandbox plus exactly one readonly file entry for
`/work/trusted-control-boundary.json` and explicit denial of
`/work/environment-appserver-home`. Root denial, private/executor HOME denial,
restricted network and the sole writable worker subtree remain unchanged. No
caller argv/env/sandbox changes or filesystem/auth/HTTP RPC are admitted. Only
the existing fixed read/terminate requests for the owned process remain available.
Before exec-server spawn, the marker must be a regular nonempty file at most 4096
bytes, admitted with lstat plus O_NOFOLLOW/O_NONBLOCK open and matching pre/open/
post dev/inode/mode/size/mtime metadata. No marker content is read by this gate.
The worker probe independently checks the readonly mount and marker semantics;
this preflight does not replace its evidence or prove immunity to privileged
concurrent writes.

This is a fixed executor probe launched beside a live authored control process,
not a model-invoked app-server tool or authenticated production dispatcher. The
parent owns concurrent app-server lifecycle and all outer cleanup evidence. No
such runtime is claimed by these source changes. Gate/trampoline scoped offline
validation: 150 tests PASS, including cross-profile rejection, immutable policy,
foreign operations, marker symlink/FIFO/size/drift/open failures, and every prior
namespace/proc/lockdown/FD rejection under both trampoline selectors.
# Cgroup diagnostic selector (no capsule runtime credit yet)

The additive literal `--trusted-cgroup-worker-boundary` admits only `cgroup_start_request()` with the readonly cgroup probe path. It retains the exact trusted-control sandbox and marker admission, including denied private HOME, and imports no cgroup mount, caller path, descriptor or environment capability. The worker command is rewritten only to the matching fixed trampoline selector. That entry retains fresh PID/mount/private-proc admission, readonly image, worker lockdown and nonstandard FD closure before executing the cgroup probe. Four write-open attempts perform no control-file read/write; any successful open remains failure. Capsule/image integration and actual runtime remain separate prerequisites.

## Additive finite candidate stress profiles (source only)

The literal selectors `--candidate-resource-stress-tasks` and `--candidate-resource-stress-memory` select isolated Gate profiles with the same names without `--`. `stress_start_request(phase)` is the only start constructor: id2, existing fixed control sandbox and clean replacement environment, tty false, pipeStdin true, and `/usr/bin/python3 -I -S /usr/bin/candidate-resource-stress-worker.py --inside-tasks` or `--inside-memory`. Before forwarding, argv is rewritten to the existing readonly trampoline plus the matching literal selector. The trampoline/image implementation is owned separately; this change grants no runtime integration credit. Historical profiles retain pipeStdin false and refuse process/write.

`stress_write_request(id, phase, action)` constructs only canonical JSONL start/ramp/release/cancel bytes, standard canonical base64, fixed processId, and mandatory `stress-PHASE-ACTION` writeId. Tasks have no ramp. All numeric RPC ids remain monotonic within the existing128 bound. Every repeated writeId is refused even though stock exec-server would deduplicate it. Empty chunks, eof/data/encoding fields, alternate bytes or profiles are not accepted. Stock Rust source (not the README's incomplete example) is archived in `scratch/session8-candidate-stress-release-protocol-handoff.md`.

A write becomes delivered only after the existing complete OS-write accounting, and accepted only after an exact matching `{status:"accepted"}` result. UnknownProcess, stdinClosed, starting or any error is failure without retry. Acceptance is enqueue admission, not proof the worker read its stdin. Held progress requires a fully delivered start; memory ramp-complete requires a fully delivered ramp. Subsequent successful writes require both the previous accepted result and the corresponding actual worker stdout progress. Either ACK or progress can arrive first. The trusted child's independent observer permission is still required externally and is never asserted by this gate. Cancel is finite, once only, and excludes further successful continuation; an outstanding read/write must finish or the owner must use its bounded failure cleanup.

The new profiles incrementally parse actual decoded stdout JSONL across chunks. Held records have exact phase-specific fields and typed worker/child identities matching the additive worker held contract. Ramp-complete is exact. A bounded terminal with the fixed workload kind/phase is preserved but full workload validation remains the dedicated child's responsibility; terminal receipt is not a resource success or cleanup attestation. Complete stdout bytes remain in the bounded progress buffer and all original wire output remains forwarded unchanged. stderr counts toward the64KiB total decoded progress budget but is not parsed as progress. At most1024 sequence fingerprints are retained; exact repeated read/notification chunks are deduplicated, differing duplicates and newly arriving older chunks fail closed. The protocol's seq namespace includes non-output events, so no contiguous-output-seq assumption is made. This is no general stdin writer, filesystem RPC, HTTP RPC or model invocation.

Validation for this revision: the complete gate file has178 mocked tests PASS in1.10s (`scratch/session8-stress-gate-unit-v3.xml`), including new finite-profile/ACK/progress/fragment/dedup/cancel/old-profile regressions. First v1 had170 PASS and8 pytest temporary-directory ACL setup errors; a workspace basetemp retry v2 had the same ACL problem and pytest session-finish error. Both are preserved. The same scoped file then passed under approved execution outside the filesystem sandbox; no actual process/network/workload was run by these mocks. An intermediate generated edit had an IndentationError before tests and was corrected before this source revision; it supplied no validation credit.

# Fixed trusted CLI worker profile

The additive literal `--trusted-cli-worker-boundary` selects the zero-argument `trusted_cli_start_request()`. Its request equals `control_start_request()` except for `/usr/bin/python3 -I -S /usr/bin/trusted-cli-worker-probe.py`. The unchanged managed sandbox retains the exact read-only `/work/trusted-control-boundary.json` entry, appserver HOME denial, restricted network, clean replacement worker environment and `pipeStdin:false`.

Admission rewrites only this fixed request to the readonly trampoline with `--trusted-cli-worker-boundary`. Existing profiles reject the new request, and the new profile rejects old probe requests, caller argv/env, permission changes and process/write. Marker absence fails before executor spawn. This entry alone supplies no CLI provenance, endpoint-lifetime, authentication or combined capsule evidence; those require the separately reviewed parent/probe composition. No actual runtime was performed for this addition.
