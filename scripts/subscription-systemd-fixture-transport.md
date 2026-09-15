# Interactive candidate systemd fixture envelope

The separate `--environment-bootstrap-metadata` relay selector binds the same
seven helper identities to the distinct `exec-environment-bootstrap-metadata`
mode. It also rejects all interactive input. It does not reinterpret the
no-filesystem metadata mode's failed actual results.

The additional literal `--environment-metadata` selects only the fixed
noninteractive `exec-environment-metadata` parent. Its exact seven-helper
identity is checked before the same resource readback, manager binding and
first start write. Input frames are rejected before forwarding. This is an
implementation prerequisite only: the environment profile has no actual
systemd run or aggregate resource credit yet. Existing fixture and metadata
pipe profiles retain their separate historical evidence.

`subscription-systemd-fixture-transport.py` is a fixed Linux relay running outside
its own UUID transient unit. It accepts the existing authored fixture control
protocol or the explicit fixed metadata-pipe variant. No generic command, unit, environment, PID or resource inputs are
accepted. No model, auth, external network or cgroup write/migration operations
exist in this program. It uses the existing systemd probe's read-only exact-leaf
helpers and fixed capsule argv.

The manager applies candidate MemoryMax=2GiB, MemorySwapMax=0, TasksMax=64,
RuntimeMaxSec=220 and TimeoutStopSec=5. Inside the unit, the unchanged capsule
retains GNU command 200/5 seconds, job 180 seconds and output 8MiB. The relay and
TS each start their own 200-second control deadline; these trigger cleanup and
cannot extend the inner limits. Relay cleanup waits at most 12 seconds in its
loop, then at most 8 seconds on the systemd-run wrapper, plus bounded 2-second
metadata/stop queries and 0.5-second failure-frame drain. These are cleanup
allowances, not another job/command deadline. TS gives the systemd relay 20
seconds after cancellation before killing only its local WSL wrapper; this never
provides remote cleanup credit. The independent manager guardian survives relay
failure. No 180/200-second fault experiment is part of this implementation.

Before forwarding ready, the relay verifies exact readback and systemd MainPID
binding. A pidfd pins that MainPID during metadata inspection; its cgroup must
equal the unique unit leaf. The explicit `private-socket-peer-v1` profile
connects only to `/run/user/<own UID>/systemd/private` with a fixed 1-second
socket timeout, reads exactly the native three-int SO_PEERCRED structure, and
closes without send/recv, D-Bus authentication or RPC. Every path directory is
opened with O_NOFOLLOW; the final entry must be an own-UID socket. Five component
metadata records (dev, ino, full st_mode, UID, GID) must match before/after.
The peer PID must exceed 1 and peer UID must equal the current user. Its pidfd,
process start ticks and cgroup are checked across observation. Preflight retains
a second pidfd and rechecks generation before spawning the unit. Ready and
pre-start repeat the private socket observation and compare the complete pinned
identity, including GID, socket components and manager generation. The unit
MainPID's parent must equal the peer PID. Both that manager and this relay
must be outside the leaf. Immediately before the first start bytes,
readback and binding run again. Start is a single write below PIPE_BUF; EAGAIN
or short write fails closed instead of queueing a stale admission.
MainPID start-time ticks join the receipt identity and must remain unchanged
between ready and pre-start. ESRCH still fails closed, and START_SECONDS stays 5.
Readback and process binding remain sequential snapshots; the MainPID pidfd is
closed before the write. They are not an atomic cgroup attestation against a
privileged concurrent writer. The reused probe import and later source hash
also depend on a trusted stable workspace and the measurement's before/after
hashes, not atomic binding of the hash to executed import bytes.

These fixed methods are defined by the [D-Bus specification](https://dbus.freedesktop.org/doc/dbus-specification.html#bus-messages-get-name-owner)
and invoked with [busctl](https://github.com/systemd/systemd/blob/main/man/busctl.xml).
They observe public bus-service ownership, not an executable identity. No
GetConnectionCredentials, credential-store access, /proc/PID/exe read, privilege
escalation or executable-read fallback is used. The second actual attempt's
PermissionError on /proc/406/exe remains FAIL: its source established only that
406 was the unit MainPID's parent; it never completed executable verification.
That denial is respected. The new binding uses a separately supported metadata
interface and does not claim executable attestation.

Both data queues are bounded to 64KiB; control frames to 4KiB/cumulative4MiB,
capsule wire to 16MiB and each capsule frame to 64KiB. There is one outstanding
fixture chunk until its actual-write ACK. Heartbeats are not accumulated under
backpressure. Ready/start timeouts and the 3-second control lease complement the
capsule's own lease. EOF closes child control; partial EOF is an explicit failure.
Output congestion never blocks the event loop on pipe writes.

An immutable `systemd_ownership` frame binds the UUID, exact leaf, driver PID and
source hashes before unit spawn. Its bytes must drain to the pipe first; this is
not a durable recorder ACK or proof that TS has archived them. TS validates and
retains ownership separately from ready, including on pre-ready failure/early
close; ownership alone never starts the fixture. A strict `systemd_failure`
must match that identity and preserves its bounded reason, actual unit-query /
leaf / wrapper-close results, and up to 4096 bytes of diagnostic stderr prefix
with observed byte count and hash. Failed or missing queries are unknown, not
absence. Failure evidence never substitutes for ready or grants remote cleanup.
Diagnostic draining can count additional bytes without retaining their body.

Failure diagnostics additionally retain up to 64 monotonic stage start/duration
records with errno, queried MainPID and public stat metadata. During failed
cleanup the relay also drains bounded capsule stdout and preserves an inner
terminal separately with the SHA-256 of its raw JSON line. It is diagnostic
evidence, never a successful outer terminal. A failed stop request followed by
an exact successful unit-not-found query and absent leaf does not add a false
secondary STOP_FAILED reason; unknown queries still fail closed.

The nested terminal's canonical JSON is limited to 8192 bytes. Larger terminals
retain raw byte count/SHA-256, canonical byte count and an explicit omittedReason
with frame=null. The complete failure frame, serialized exactly as Buffer.frame
including its newline, is limited to 60000 bytes, below the 65536-byte queue.
If needed it omits the nested body, reduces stage events while incrementing
eventsDropped, then reduces the stderr prefix with stderrPrefixTruncated=true.
The primary error and immutable ownership are preserved. Tests exercise near-cap
raw terminals, Unicode expansion and maximum stage/prefix data using the actual
Buffer.frame serializer; no source or queue limit was increased.

The third actual attempt (0429ce0a...) remains FAIL with pre-ready ESRCH. The old
code's blocking four-RPC discovery within the capsule start window establishes a
bootstrap lifetime risk; absent stage/inner-terminal evidence, it does not prove
that risk caused the historical failure. The new preflight ordering fixes that
risk without increasing job/command/start/TERM limits or ignoring a dead PID.

The first actual attempt predating this protocol lost its initial failure reason
to TS FRAME_ORDER and had no archived UUID. It remains FAIL. Subsequent read-only
journal metadata in its narrow time window found exactly one candidate UUID;
an exact query observed LoadState=not-found/MainPID=0 and absent leaf. Association
to the earlier run remains an inference, not historical pidfd-cleanup proof.
Raw query records are in `scratch/session8-systemd-fixture-failed-readonly-metadata.json`
and `scratch/session8-systemd-fixture-failed-readonly-exact-unit.json`.

The PID1 terminal is held until systemd-run closes, the exact UUID unit reports
LoadState=not-found and its leaf is absent. No metadata reset or glob stop occurs.
The ready/terminal receipts bind unit, source hashes, exact limits, process
placement, initial and pre-start readback, and own-unit cleanup. TS additionally
requires the capsule's pidfd/namespace cleanup. Missing or invalid proof leaves
remote termination unknown; protocol ACK/local WSL close alone gives no credit.
Failure paths attempt only an exact UUID unit stop and emit bounded failure
evidence, never a successful terminal. Fixed systemd-run diagnostic stderr is
bounded but is not authored child stderr or model output.

`aggregateResourceReadbackValidated:true` and the final compatibility field
`aggregateResourcesValidated:true` mean this candidate configuration/readback
and cleanup were validated. `candidateExhaustionValidated:false` is explicit:
this is neither a 2GiB/64-task exhaustion test nor a general hostile escape proof.
Historical 64MiB/16-task stress results are not reclassified.

Python unit tests mock the OS; TS tests mock spawn. Runtime evidence requires a
separate reviewed systemd fixture measurement with source hashes before/after.

The fourth historical attempt stopped before unit spawn: public GetNameOwner
failed with exit 1 but stderr was then discarded. A separately authorized single
metadata RPC reproduced `no such name` on the user bus, preserved in
`scratch/session8-busctl-getnameowner-readonly.json`. Version/help metadata showed
all fixed flags supported. A separate single private socket metadata connect
observed stable own-UID path metadata and peer PID/UID/GID, preserved in
`scratch/session8-systemd-private-peer-readonly.json`. These observations neither
rewrite historical failure evidence nor prove the full new transport runtime.
The public manager RPC implementation was removed; private peer is the sole
explicit profile, with no activation or fallback. SO_PEERCRED establishes kernel
peer metadata, not executable attestation or resistance to a privileged
concurrent actor. No /proc/exe or credential stores are read.

Failure diagnostics now include `notSpawned`. True means the relay has no
systemd-run subprocess object; `systemdRunClosed:false` in that case is not an
assertion that a process was stranded. Neither field grants ready or remote
cleanup credit. Primary reason, stage errno/timing, exact unit/leaf observations
and the unchanged canonical 60000-byte failure envelope remain preserved.

Private-profile first scoped unit attempt: Python 29 PASS / 9 FAIL because Windows
lacked AF_UNIX in the mocked fixture. The test fixture now supplies the Linux
socket constants explicitly; this is not a kernel validation. TS first scoped
37 PASS. Subsequent counts are recorded by the task owner after final tests.

Final private-profile scoped validation: Python 42 PASS, TS fixture transport 45 PASS, scoped diff-check exit 0. Full TypeScript validation is coordinated by the main agent. These are mock unit results; the new full runtime remains gated on review.

## Explicit metadata resource variant

The only new command-line selector is exactly `--metadata-pipe`. No arguments
still selects the authored fixture. Unknown flags, values or extra arguments
fail before importing the probe or spawning/querying a unit. This selector does
not accept caller argv, configuration, environment, RPC or arbitrary mode names.

The shared admission code validates the selected start contract before calling
the unchanged resource readback/current private-peer identity/atomic write path:

- Fixture: mode `appserver-fixture`, fixed scenario normal/cancel/output-limit,
  exact two-helper map from appServerFixtureBoundary.
- Metadata: mode `appserver-metadata-pipe`, no scenario, exact four-helper map
  from appServerMetadataPipeBoundary (metadata child, noenv policy helper,
  lockdown helper and text model catalog).

Missing, extra, malformed or changed hashes, foreign modes/ready fields, and
scenario-shape confusion fail before resource admission or first start bytes.
The supervisor independently revalidates the copied image hashes. Ready normally
contains both helper boundary fields; only the selected fixed profile is admitted.

The historical `systemdFixtureBoundary` wire name is preserved for the shared
resource receipt; it describes candidate limits and cleanup, not authored-model
provenance. The actual capsule mode and TS evidence kind identify metadata versus
authored fixture. No new readiness schema or second broker implementation exists.
Private peer identity, UUID-only cleanup, ownership/failure receipts, bounded
control/ACK queues, output accounting and all time/resource limits are shared
unchanged: inner command200/5, job180, manager220/5, output8MiB, 2GiB/swap0/tasks64.
Candidate exhaustion and general hostile escape remain unvalidated.

Variant scoped validation: 69 Python unit tests PASS, including both exact
profiles, forbidden selector arguments, cross-profile/hash confusion with no
resource admission/write, and positive shared readback -> identity -> write order.
Existing race, failure-envelope and cleanup tests ran in the same file. This is
offline validation; earlier actual fixture and basic metadata runs do not prove
the new combined metadata/systemd variant.

## Separate inherited ingress profile

`--trusted-ingress-boundary` creates one owned private rendezvous and launches
its fixed receiver as the initial unit MainPID. SCM_RIGHTS admission reuses the
private-manager, pinned generation, cgroup and exact resource readback checks.
The receiver execs the original 200s command/5s grace chain with fd198; the inner
180s job and manager 220s guardian retain their original limits. A separate 5s
handoff setup budget applies before the inner command starts.

The relay binds post-pivot socket identity and MainPID generation to the actual
handoff before exposing ready. Start requires exactly ten helper hashes and the
owned nonce, with no interactive inputs. New `systemd_ingress_ownership`,
`systemd_ingress_handoff` and `systemd_ingress_terminal` frames preserve their
own provenance. Existing capsule and resource terminal evidence remains separate.
A successful terminal also requires broker EOF, peer/thread closure and removal
of the exact owned rendezvous path. Handoff ACK alone establishes none of these.

Setup exceptions after rendezvous creation and selector setup after process
spawn now enter owned cleanup. Failure drains require nonblocking pipes, and
one handle close failure does not skip the remaining handles. Unknown cleanup
cannot become a successful local exit. Offline shared relay tests: 146 PASS in
`scratch/session8-systemd-ingress-relay-unit-v4.xml`. Actual systemd ingress passed
in the separately archived d2e7292e attempt; see the dedicated measurement document.
No auth,
external egress, real provider or candidate exhaustion credit is claimed.
# Additive fixed HTTP ingress profile

`--trusted-http-ingress-boundary` selects the fixed HTTP rendezvous constructor,
whose receiver preserves the same SCM_RIGHTS and ACK ownership checks before
executing the HTTP capsule selector. START requires the exact fourteen HTTP
helper hashes and the nonce from the physical systemd ingress handoff. The old
ten-helper ingress profile remains separate; cross-profile requests and extra
helpers are rejected before resource admission or dispatch.

This implementation preserves the existing raw handoff frames, resource
readback, command/guardian budgets, broker bytes and cleanup domains. It does
not establish a successful systemd HTTP run. The dedicated measurement must
also validate the actual HTTP loopback receipt and child listener/worker
evidence; neither can be inferred from a resource readback or SCM ACK.
# Separate stock CLI proxy-refusal selector

`--cli-proxy-refusal` uses the original non-ingress capsule command with exactly
one fixed shell selector appended. It requires the ten-helper refusal START,
has no nonce or FD198 handoff, and remains noninteractive. An ingress profile
without its rendezvous cannot fall back to this capsule path. All existing
resource, MainPID, guardian and unit cleanup checks remain shared. This new
systemd selector has implementation tests only until its dedicated actual
measurement; the basic CLI proxy-refusal result does not confer systemd credit.

## Fixed cgroup worker profile (source implementation, no actual run)

The literal --trusted-cgroup-worker-boundary selects mode trusted-cgroup-worker-boundary and trustedCgroupWorkerBoundary with exactly the original control eight helper hashes plus the cgroup probe and child. Its capsule argv differs only by the same fixed shell selector. This noninteractive profile has no nonce, FD198, rendezvous, or caller RPC. Cross-profile starts and missing/extra/changed helper hashes fail before the shared resource admission call. Original private-manager/MainPID generation, exact 2 GiB / swap 0 / tasks 64 readback before START, inner 200/5 and additive outer 220/5 guardian, and exact owned-unit/leaf cleanup are reused unchanged. Existing selectors remain unchanged. These additions do not grant current kernel/cgroup write-open or candidate exhaustion credit; a separate actual run and replay are required.

Scoped cgroup relay validation: 167 offline tests PASS in session8-systemd-cgroup-relay-unit-v3.xml after narrowly approved test execution. The first attempt retained 166 PASS / 1 Windows pytest temp ACL setup ERROR (v1); the second workspace-temp attempt also hit WinError5 (v2). Neither was an assertion failure or actual systemd run, and both artifacts remain preserved.

## Candidate tasks/memory stress plumbing — not yet runnable

Two additive literal profiles `candidate-resource-stress-tasks` and `candidate-resource-stress-memory` now have fixed capsule selectors and exact11-helper source maps: the existing8 trusted-control helpers plus the fixed stress worker, protocol and child. The ready field is `candidateResourceStressBoundary` with exactly `phase` and `helperSha256`; phase and every helper key/hash must match before START. There is no FD198, nonce or ingress rendezvous for these profiles.

The fixed stress unit argv adds only `OOMPolicy=continue` to the existing 2GiB/swap0/tasks64, 220-second guardian, 200-second inner capsule and5-second stop limits. Its ready and immediate pre-START readback additionally require physical `memory.oom.group` zero and exact `OOMPolicy=continue`. The cgroup file is reached with component-relative no-follow directory opens and a bounded read. Prestart drift refuses before the existing actual START write; historical profiles retain their old readback and property shape.

`StressActions` accepts only finite start/release (tasks) or start/ramp/release (memory), with a once-only cancel alternative. It allows one pending action and requires an exact `stress_action_delivered` event before another action; both `workerAcknowledged` and `observerAdmissionAttestedHere` must be false. Duplicate, reordered, foreign-profile or credit-bearing delivery events are refused. The ordinary bounded relay queues carry the original action and event; pipe delivery is not worker ACK or resource permission.

The internal token-bound `create_stress_composition(phase, absolute_deadline, expected_source_hashes)` has exactly five source keys: observer, retained-events reader, relay, systemd probe and capacity helper. Fixed source bytes are no-follow bounded reads and are hash-checked before private compilation; the observer validates its own three exact dependency hashes. The observer factory generates the only unit identity. No public unit/PID/argv/capacity-callback adoption is offered. The owned observer is closed idempotently and unknown close fences further composition factories.

**The composition is deliberately not executable yet:** `StressComposition.run()` refuses `STRESS_CAPACITY_AND_PROGRESS_INTEGRATION_REQUIRED`, and direct CLI stress entry refuses before probe load/unit creation. This prevents the old standalone relay UUID factory from silently bypassing observer ownership. The observer/capacity modules are bound, but their actual external-view/capacity checks, child-progress decoding and resource-driven release are not wired into the loop in this revision. The separately agreed future progress envelope is exact `{version:1,type:'candidate_stress_progress',phase,record,rawHex}` in actual child stdout. It must be decoded from unchanged supervisor child_output bytes, validated against the actual worker JSONL, and drive observer held/admit/sample and memory-ramp outcome evidence before finite release. No such observer permission is currently invented from action delivery. Source or component tests alone grant no stress, exhaustion, runtime or cleanup credit.

Validation: full relay scoped suite187 mocked tests PASS in0.80s (`scratch/session8-stress-relay-unit-v6.xml`). V1 preserved183PASS/1 Windows platform-mock FAIL/1 tmp_path ACL ERROR; v2 corrected those with approved scoped execution,185PASS. V3 stress subset17PASS; v4 composition subset3PASS/1 native Windows text-mode source-read mismatch; v5 explicitly binary source-read mock4PASS. The runtime Linux source path was not relaxed for that test correction. Source factory tests compile the real verified dependency files, bind the actual generated observer unit and refuse run before Popen. No actual systemd, cgroup, workload, socket, auth or network operation occurred.

### Owner-loop hookup revision (supersedes the v6 refusal-only state above)

The token-bound owner's `run()` now calls the shared relay loop using exactly the observer-generated unit and its privately loaded probe. A standalone stress CLI accepts one initial JSONL packet `{type:'stress_composition',sourceSha256:{exact5}}`, with no other keys, before ordinary control traffic. The fixed selector determines phase; there is no caller unit, PID, command, resource limit or capacity callback. This prelude is limited to4096 bytes and5 seconds, read one byte at a time so subsequent heartbeat/start frames cannot be consumed accidentally. The common180-second owner deadline begins before reading it. Unknown owner close changes even an otherwise zero loop return to failure.

After the retained private manager preflight and before Popen, the owner verifies its own, manager's and PID1 PID/cgroup namespace links are equal, then performs a fresh fixed capacity check (at most5 seconds, clamped to the original owner deadline) and rechecks the same namespace/generation observations. These are metadata-only fixed paths, not authentication data. A second fresh capacity check occurs before the finite workload start action. The current capacity result is a headroom observation, not a reservation; the archived earlier capacity experiment is not reused as current admission.

The existing resource/private-peer/oom0/OOMPolicy checks still occur before capsule START. Observer baseline opens immediately AFTER the actual capsule START write, before any stress_action/start. This avoids consuming the inner fixed START5-second bootstrap window with additional observer RPCs. The driver must wait for both baseline observation and supervisor started event before requesting workload start. Read-only metadata may still exhaust the existing absolute/control-lease budgets; no timer is reset or extended to conceal that.

Original supervisor child_output bytes remain unchanged. The owner separately decodes bounded stdout JSONL and validates the exact progress envelope `{version:1,type:'candidate_stress_progress',phase,record,rawHex}` against its actual encoded worker line. Held records feed only the exact phase/workerIdentity/childIdentities projection into observer admission; memory ramp-complete must be the fixed actual record. Final child report content is preserved for the independent driver, not converted into an observer success. The total decoded child stdout remains128KiB and incomplete final JSONL is refused.

The owner emits bounded `candidate_stress_observation` frames with exact top fields version/type/phase/unit/stage/evidence/exhaustionValidated(false). Stages are before-unit-capacity, baseline, before-work-capacity, workers-held, and release-observation. Each record is capped at45000 serialized bytes; at most40 hashes are retained. A release-observation carries sample/outcomes/releaseAdmitted. Tasks require a new pids.events.max increment and pids.current exactly64. Memory requires a new memory.events.oom_kill increment and an exit observed on a previously pinned allocator-child identity; an exited worker or unrelated identity cannot qualify. The worker must remain alive. Sampling is bounded by the reader's original32-sample cap and original absolute deadline. The same conditions are freshly rechecked immediately before forwarding release; a stale grant is insufficient. Missing evidence stays false or fails; no elapsed-time guess grants release.

The driver waits for workers-held before memory ramp, and for release-observation releaseAdmitted true before either release. Pipe-delivery events remain workerAcknowledged=false/observerAdmissionAttestedHere=false. The release grant is not final stress PASS: actual worker-owned wait status, allocator SIGKILL/survivor progress, full child replay and own unit/leaf/process cleanup remain required externally. Only after the existing exact own-unit absence/leaf absence/run-close checks does the relay close observer handles and add terminal `candidateStressObserver` source hashes, emitted observation hashes and localHandlesClosed; exhaustionValidated stays false.

Validation after hookup: v7/v8 targeted subsets35/36 PASS; full v9 relay suite197 mocked tests PASS in0.92s (`scratch/session8-stress-relay-unit-v9.xml`). Added tests exercise real owner progression, exact raw wrapper binding, resource proof discrimination, late grant recheck, unknown close affecting run result, prelude non-overread, and the actual shared loop's generated-unit/capacity-refusal-before-Popen path. No actual workload, unit or external network ran. The earlier refusal-only source revision and all failed test receipts remain historical evidence.

### Lease-safe observer scheduling and actual-write admission

Review of the first hookup identified two concrete gaps: blocking observer metadata could prevent forwarding supervisor heartbeats past its unchanged3-second lease, and release permission was checked before queueing rather than the first actual write. Both are corrected in this revision.

All post-START observer operations (baseline, held/output processing, fresh pre-work capacity, and release sampling/recheck) execute in one owned metadata thread at a time. A fixed-kind queue admits only baseline/output/action work, capped at64 items and262144 encoded bytes; periodic tick work is internally selected. No generic caller callback is accepted. The main relay thread continues its original nonblocking control/output pumping and guardian handling while metadata waits. A test blocks an actual owned metadata thread and demonstrates actual mocked write calls forwarding both heartbeat and stdout before releasing that thread. Observer calls cannot overlap.

A completed action admission is consumed on the main thread only after the metadata thread has terminated. The control queue must be empty; the action is written once directly as the complete fixed small JSONL frame. EAGAIN, a partial write, noninteger/boolean count, stop/terminal state or more than100ms between metadata completion and consumption fails closed without deferred action retry. The100ms freshness restriction is an additional refusal bound, not an increase of any job/command/lease/grace limit. The observations remain sequential rather than an atomic guarantee against resource changes during a syscall.

The metadata worker uses a separately owned duplicate of the retained manager pidfd. Relay cleanup may close its original handle without reusing the worker's descriptor. Shutdown stops queued work and joins the active worker for at most one second within the original owner deadline. If the worker remains active, observer/pin descriptors are deliberately not closed underneath it, cleanup remains unknown, and subsequent composition dispatch is fenced. Process exit is not mislabeled as known observer-thread cleanup. Thread-start failure is handled without inventing a started thread. Normal completion requires no pending job before the unit terminal is sealed.

Full scoped relay v12:210 mocked tests PASS in1.00s (`scratch/session8-stress-relay-unit-v12.xml`). The added tests cover blocked-metadata heartbeat/output forwarding, unknown-thread no-close/fence behavior, fresh versus stale completion, EAGAIN/backlog single-write refusal, thread-start failure, and manager-duplicate ownership. No actual workload/systemd/network run occurred. The separate review finding that a many-child report can exceed the unchanged128KiB stdout budget remains a child-representation integration issue; this relay does not silently increase the limit or claim that such a report already passes.

### Lossless child serialization envelope correction

Root explicitly authorized aligning only the relay's decoded stress-child serialization aggregate with the child's already-existing3MiB Output envelope (which separately caps its final JSON record at2MiB). This fixes the reviewed mismatch: valid authored50/64-child reports exceed128KiB because they preserve raw protocol/history and repeated evidence, even while the underlying parent/session capture remains within its own128KiB budget. No raw/history is removed or normalized. The earlier mismatch finding is preserved; no run is retroactively relabeled.

`STRESS_CHILD_OUTPUT_LIMIT` is now3MiB. Parent/session raw128KiB, worker decoded64KiB, CLI/model output8MiB, outer wire16MiB and all time/resource limits are unchanged. A real crossing byte increments the observed decoded total and is refused before extending the retained partial buffer. The metadata worker queue stays at64 items/262144 bytes; when queued metadata/output exceeds128KiB, the main loop applies capsule-pipe backpressure while continuing control/diagnostic/output pumping, rather than enlarging that queue.

Tests import the real child's authored fixture builder, validate complete50- and64-child reports through its actual pure validator, and stream the complete progress-plus-final JSONL in4096-byte chunks through the relay owner's decoder. Both retain the full byte count and complete progress identity set. A separate actual3MiB mocked input crossing test confirms limit+1 observation without retaining the crossing byte. Final relay v14:213 mocked tests PASS in1.58s (`scratch/session8-stress-relay-unit-v14.xml`); focused v13 had3PASS. No Linux workload or resource experiment was run.

### Cancellation and unknown observer shutdown closure

An exception from metadata-worker finish, join or liveness inspection now seals observer cleanup as unknown and sets the sticky composition fence. Idempotent later close cannot turn that result into known cleanup. Observer descriptors and the separate manager pin are not closed while worker termination is uncertain.

Receiving caller cancellation immediately stops observer scheduling and clears queued work before forwarding the original cancel frame. An already-completed action admission is discarded by the actual buffer pump instead of being written after cancellation. Raw capsule output and cancellation continue through the main relay; post-cancel output does not enqueue new observer work. This is cancellation enforcement, not proof that the worker consumed the cancel or that remote cleanup completed.

Full scoped v17: 217 mocked tests PASS, zero errors/skips, in 1.036 seconds (scratch/session8-stress-relay-unit-v17.xml). Regressions cover finish/join/is_alive exceptions, repeated close and next-factory fencing, plus actual cancel admission followed by the real buffer pump with a completed action. Focused v15 preserved four failures caused by an older mock's unspecified cancelled attribute evaluating truthy; explicitly initializing that test double to false yielded v16 eight PASS. No runtime source behavior was relaxed for the mock correction. No actual workload, systemd unit or network run occurred.


### Explicit common-visible cgroup stress composition

The separate --candidate-common-view-stress-{tasks,memory} selectors accept an
exact twelve-source prelude. They retain the existing finite capsule workload and
all job, command, kill, resource and output limits. Legacy source5 and its
protected-manager namespace prerequisite remain unchanged.

Before target Popen, one asynchronous credential-free metadata service proves
its observer/helper shared visible cgroup2 hierarchy and cleans its own unit and
pins. The nonblocking pump handles heartbeat, cancel, EOF and bounded output.
Only after the complete service document physically drains does the relay emit
its preflight receipt and ready digest, then require matching driver admission.
Queue polling counters are not actual delivery acknowledgements.

Fresh paired self snapshots bracket capacity reads. After capsule START, the
same retained EventReader binds the real target leaf using the exact after-open
snapshot under a five-second freshness bound. The target document precedes
baseline/work permission. Complete source-bound linkage validates all six
metadata documents before work. Private manager generation and pinned liveness
checks remain active. This is a common visible hierarchy, not initial-host or
manager namespace proof.

The fixed chunk codec uses bounded owner storage. One cumulative counter covers
actual stdout writes across ownership, preflight, documents, observations,
capsule and terminal buffers, reserving terminal space below 16 MiB. Document
drain never resets the 100ms completed-admission timestamp. Stale, partial or
EAGAIN action delivery fails. Cancellation drops pending grants. Unknown or
exceptional common-controller close keeps the sticky fence and leaves handles
owned by any still-live metadata worker.

Independent integration source review v2 PASS: scratch/session8-common-stress-integration-review-v2.md.
Relay/observer v8:259 offline PASS. Pretarget v10:six offline PASS, including
admission, wrong digest, cancel, EOF, duplicate admission and oversized partial
input. The v9 duplicate fixture mistakenly supplied a wrong digest; its FAIL is
preserved. These are component results, not actual candidate exhaustion.


### Observer failure diagnostics after the first common-profile actual

Failed metadata jobs now retain the fixed job kind, exception type and, only for
an exact ValueError with an uppercase symbolic reason of at most128 characters,
that reason. Arbitrary exception text and unknown job names are not copied. This
is a lexical symbol filter, not a claim that every possible symbol is enumerated.
The previous generic memory failure remains unchanged in its archived raw report.

Focused observer/relay delta:15 offline PASS; independent source review PASS in
scratch/session8-memory-pidfd-diagnostic-source-review.md. No new runtime repeat
is represented by these tests. Full source/archive binding must be renewed.
