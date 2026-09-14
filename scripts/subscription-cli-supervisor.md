# Fixed credential-free CLI supervisor capsule

This is a synthetic transport/cleanup implementation. It is **not an authenticated
production dispatcher**. Production auth, network and cleanup remain `NOT_RUN`;
`productionReady` is always false. No host auth/session file, credential store,
login/status command, prompt, inference or paid API is used.

## Boundary and protocol

The additive `trusted-control-boundary` mode requires exactly eight image hashes
in `trustedControlBoundary`: the six direct-executor helpers plus the trusted
parent and probe. It runs a fixed Python parent with no caller arguments or
interactive input. After pinning that parent, PID1 sends one bounded internal
startup packet containing only its own ready PID/mount namespaces and control/
output FIFO identities, then closes the private pipe. A partial or failed write
enters owned cleanup. No supervisor FD is inherited and no parent ptrace or
dumpability restriction is relaxed. This is a credential-free control-boundary
experiment, not an authenticated launcher or genuine app-server tool dispatch.

The separate `exec-environment-bootstrap-controlled` mode uses the same seven
environment helper hashes as the older metadata modes and a literal parent
`--bootstrap-controlled-cleanup` argument. Its validator distinguishes natural
exit zero from a recorded own pidfd TERM and matching reap. Older natural-exit
experiments and their failures retain their original acceptance conditions.

The shell has no caller arguments. Launch it only in a fresh exclusive user,
mount, network and PID namespace, with current-user mapping and setup capabilities.
It copies the pinned Linux 0.145.0 CLI, bundled bwrap, Python/setpriv and their
runtime dependencies to tmpfs. PID1 uses `pivot_root`, detaches the old host root,
closes inherited descriptors above stderr and reexecutes from its read-only copy.
It reuses the existing `subscription-runtime-probe.py` boundary and private-sentinel
validator. Host HOME/mnt/root are absent; network has only loopback. The child has
zero capabilities, NoNewPrivs, a clean environment and synthetic HOME/CODEX_HOME.
CLI and bwrap SHA-256 are checked before executing either. The private profile is
new synthetic configuration, never user configuration.

Input is bounded JSONL with exactly these forms:

- `{"type":"start","mode":"version"}` (or `private-sentinel`, `sleep`, `setsid`,
  `flood`, `partial-setup`, `stopped-cli`, `paced-output`). No caller argv, command, executable or limit override.
- `{"type":"heartbeat"}` refreshes the 3-second lease after start.
- `{"type":"cancel"}` initiates owned cleanup.

A start is required within 5 seconds after capsule readiness. Fixed commands are
CLI `--version` and CLI `sandbox --permission-profile private-sentinel` running
one of two bundled synthetic Python programs. `partial-setup` injects a failure
immediately after Popen, before pipe setup, to test actual partial initialization.

Output is JSONL `ready`, `started`, `fixture_ready`, `child_output`, `failure`, `terminal`.
Child bytes are base64 **data**, never parsed as supervisor events. The PID1 report
pipe is absent from child inheritance; existing private-sentinel checks distinguish
nested PID1's own output from the protected outer report pipe. This is a trusted
caller/local code boundary, not cryptographic report provenance or a claim against
all hostile user/mount namespace operations.

## Bounds and cleanup

PID1 multiplexes control and child pipes through nonblocking reads. Output writes
are nonblocking with a 64 KiB queue. There is no host audit write/fsync in its event
loop. A slow/disconnected peer causes cleanup; a missing terminal acknowledgement
must be interpreted as **cleanup unknown**, even if the process later exits.
An external stdout consumer may archive frames; consumer persistence never becomes
a precondition for PID1 to process cancellation or kill a child.

The fixed job deadline is 180,000 ms, TERM grace 5,000 ms and total observed child
output bound 8 MiB. The required outer command budget is 200,000 ms; the measurement
launcher's fixed `timeout --signal=TERM --kill-after=5 200` enforces that budget
outside the capsule. PID1 reports that it does not itself enforce the outer budget.
The 768 MiB runtime and 64 MiB root tmpfs capacities are filesystem capacities,
**not aggregate RAM/process/CPU limits**. Aggregate resource enforcement remains false.

All visible processes belong to the exclusive PID namespace. PID1 inventories
owned pidfds, sends TERM, repeats discovery, escalates to KILL after 5 seconds and
reaps. Stale ESRCH handles are retired before a reused PID can be observed again.
The active registry has a 4,096-handle safety bound (not a kernel process limit);
overflow fails closed and kills newly observed children. Signal-failure samples
are bounded to 32. The direct child's real wait status is preserved when the
adopted-child reap races Popen.poll(). Final verification requires empty namespace,
ESRCH on every observed pidfd, no signal failure and no registry overflow.

Final pipe drain is bounded and nonblocking, including pipes created before a setup
failure. `outputComplete`/`streamEOF` state whether all bytes were consumed;
`observedOutputSha256` hashes observed interleaved pipe chunks and is not a claimed
complete response hash. `outputLimitExceeded` remains fatal even if EOF/exit/cancel
was already the original stop reason. Supervisor exit zero means acknowledged
cleanup/transport completion, **not successful inference or successful child exit**.
The consumer must inspect reason, child exit code and required fact checks.

## Evidence

`python -B scripts/__tests__/subscription-cli-supervisor.test.py` verifies fixed
control/limits, rejection of caller overrides, racing wait status, PID reuse status,
bounded nonblocking/broken-peer output, missing acknowledgements, source drift and
early-deadline rejection, received-transcript verification and fixed fault assertions
(21 tests). These are offline unit tests.

The actual WSL runs are separate `scratch/session7-cli-*-final.json` artifacts with
command, source SHA-256, all emitted frames, stderr, child/launcher status and timing.
Earlier `*-validated.json` attempts are preserved; the initial restricted WSL launch
failed before executing the capsule, and its artifact is retained. A standard narrow
WSL escalation enabled subsequent namespace launches.

Version/private-sentinel and cancel/EOF/lease/setup/flood scenarios exercise actual
installed CLI without inference. TERM may terminate the nested CLI PID namespace
and thereby remove even setsid/TERM-ignoring synthetic descendants before the 5s
KILL branch. Such a run proves its observed cleanup only, **not KILL escalation**.
The actual 180s job deadline was measured in
`scratch/session7-cli-deadline-measure-22cfcc3e-031e-4075-aad3-f497103d6cb8.json`:
`JOB_DEADLINE`, capsule elapsed **180,042 ms**, outer elapsed 190,641 ms, complete
output and verified empty namespace/5 observed pidfds ESRCH. Source hashes were
unchanged during that run. TERM sufficed; no KILL escalation was observed. Two later
internal hardening changes moved control-buffer size validation after complete-frame
splitting and corrected `killSent` when the safety registry overflows. The deadline
measurement remains bound to its recorded prior source hashes; it is not relabeled
as a second deadline run on later bytes. Version/cancel smoke verifies the later code.
The 200s command timeout, aggregate resource envelope for this capsule, authenticated
sandbox/egress and production cleanup remain unmeasured. Original flood hit the
stricter bounded report-queue backpressure first. The additional fixed fault
measurements below separately exercised actual 5s KILL and the 8MiB threshold.

The durable fixed measurement driver is
[`subscription-cli-supervisor.measure.py`](subscription-cli-supervisor.measure.py).
It accepts one named scenario, freezes before/after source hashes, archives a unique
PREPARED attempt before dispatch, uses bounded readers and an independent bounded
control writer, verifies received child-output bytes/SHA for complete transcripts,
and rejects missing acknowledgement as unknown cleanup. A flood may pass its
synthetic cleanup/backpressure expectation while `transcriptIntegrity` remains false;
that is never complete-transcript credit. A spawn
failure is archived. Its outer Windows-client fallback kill cannot itself prove
WSL descendant cleanup. `scenarioPassed` is a synthetic validator result only.

The standalone TypeScript adapter is
[`subscription-cli-probe-transport.ts`](subscription-cli-probe-transport.ts), with
actual integration measurement in
[`subscription-cli-probe-transport.measure.ts`](../evals/reality-compiler/subscription-cli-probe-transport.measure.ts).
It validates fixed frames, pinned runtime hashes, output byte count/SHA and cleanup;
there are no generic launch parameters. Its separately retained actual
version/private-sentinel/cancel measurements are referenced by
`scratch/session7-cli-ts-actual-first.json` and the corresponding unique run summary.
This remains credential-free synthetic transport, with no production Command
integration, authentication or inference.


## Actual TERM/KILL and output-cap fault measurements

Two additional named modes are synthetic fixtures only:

- `stopped-cli`: fixed CLI sandbox sleep. PID1 waits until its owned direct process
  exposes exactly `/usr/bin/codex` as its executable (never credits pre-exec
  setpriv), sends SIGSTOP through the owned pidfd, and observes `/proc` state `T`.
  It then emits `fixture_ready`. A 5s fixture setup budget fails closed if actual
  stopped CLI cannot be observed. The caller sends normal cancel after readiness;
  it cannot select any PID, executable or signal.
- `paced-output`: fixed finite child output of 9 MiB in 4 KiB chunks separated by
  10 ms, plus its short synthetic header. The active reader reaches the unchanged
  8 MiB cap before queue backpressure. The crossing chunk and any later bytes are
  counted/hashed as observed bytes but are not emitted or archived as body.

`fixture_ready` has exact fields `version:1`, `type:'fixture_ready'`,
`mode:'stopped-cli'`, `kind:'owned-cli-stopped'`, positive `pid`,
`executable:'/usr/bin/codex'`, `state:'T'`, `signal:'SIGSTOP'` and nonnegative
`sinceStartMs`. Terminal always includes `fixture`, either null or those six
fixture fields (without version/type/mode), and `terminationElapsedMs`, a
nonnegative integer or null when termination never started.

- Stopped actual CLI **PASS**:
  `scratch/session7-cli-stopped-cli-measure-09f6424b-0183-46fb-9e4f-6819998503ed.json`.
  Observed actual executable and stopped state; CANCELLED; TERM/cleanup elapsed
  **5,063 ms**; actual child status **-9**, `killSent:true`, five observed pidfds
  ESRCH and empty namespace. No production cleanup credit is assigned.
- Paced cap **PASS**:
  `scratch/session7-cli-paced-output-measure-dc7a5846-1ddc-4a0e-b69e-605dc09ed3b9.json`.
  `OUTPUT_LIMIT`, `outputLimitExceeded:true`, **8,388,649 observed bytes** (cap+41),
  complete pipe drain and verified cleanup. Archived raw child bytes remain below
  8 MiB; delivered transcript integrity is false because the over-cap tail is
  deliberately metadata-only. This run preceded only the internal emit-parameter
  rename described below; no second run on later source bytes is claimed.

The first stopped-CLI attempt is retained at
`scratch/session7-cli-stopped-cli-measure-062dc1af-e2cc-4812-b514-4d7cf2ae93f3.json`.
It observed the real stopped executable but failed due to the old method parameter
`kind` colliding with the new payload field `kind`. Emergency finally cleanup sent
KILL immediately; that attempt is **FAIL**, not 5s evidence. Renaming the internal
method parameter to `event_type` fixed the collision without changing the frame
schema. A targeted regression test and the subsequent actual 5s run passed.

`scratch/session7-cli-summary-v2.json` links these attempts and current source hashes.
The earlier `scratch/session7-cli-summary.json` is preserved unchanged. Earlier
180s and standard transport measurements retain their own source identities.

## Fixed executor and environment integration

The `exec-server-worker` mode launches the fixed Python gate directly after
the same setpriv/no-new-privileges setup. It deliberately does not put the
trusted exec-server under the worker filter before its own sandbox setup.
The existing bounded input queue, lease, 180s job, outer 200s command/5s grace,
8MiB output policy and owned descendant cleanup are reused.

`execServerWorkerBoundary.helperSha256` pins exactly the gate, trampoline,
probe, lockdown, existing noenv policy and model catalog. Those helpers are
copied into the read-only runtime image. The start frame has no scenario,
argv, environment or caller path. The first successful runtime is archived in
`scratch/session8-exec-server-worker-7ba4ab02-c782-4e57-8e8d-2b95fd69302b/summary.json`.
It is an explicitly credential-free basic capsule with no aggregate resource
credit. Three preceding failures and their source identities remain preserved.

The image uses real readonly bind mountpoints for `/bin`, `/lib` and `/lib64`
over the corresponding `/usr` data. This preserves the Python ELF interpreter
path through the stock sandbox's root-path canonicalization. Only the explicit
supervisor runtime profile permits these three mounts; it requires unique
mountpoints with ro/nosuid/nodev and validates directory/inode/device/readonly
identity before ready. Existing standalone runtime profile defaults remain.

The later `exec-environment-metadata` mode starts its fixed trusted parent
directly, with no caller input pipe. Its separate seven-helper ready map adds
the parent to the existing six executor helpers. It will test actual
environments.toml selection; that experiment is separate from the earlier
direct executor PASS and is pending source review and measurement.

This direct executor integration is separate from actually selecting the
supported environments.toml program hook in app-server. That selection and
authenticated control are not validated by this mode. A future inherited
program environment must be sanitized before process startup; a Python
environment dictionary applied to a later child cannot prevent earlier loader
injection. Historical runtime results above retain their original sources.
# Separate bootstrap metadata profile

`exec-environment-bootstrap-metadata` is a separate fixed noninteractive mode.
It launches the same source-bound parent with literal `--bootstrap-metadata`,
using the existing exact seven-helper boundary. No caller argv or scenario is
accepted. The historical `exec-environment-metadata` mode remains unchanged in
scope and its two failed actual attempts remain failures.

The new profile is intended to accommodate the pinned client's finite skills
warmup metadata request through a separately reviewed gate. It permits no
content read, arbitrary path, model turn or auth operation. Implementation alone
does not supply runtime or production credit; the parent and actual metadata
reply must pass their distinct validator and the original outer cleanup checks.

## Fixed inherited ingress profile

The separate shell argument `--trusted-ingress-fd` accepts one already connected
AF_UNIX stream on fd198. The launcher owns its creation; neither stdin nor a
start frame can select a descriptor, socket, path or command. The supervisor
checks device/inode/type and socket properties before and after pivot, closes
all other nonstandard descriptors, and requires bootstrap descendants to be
absent before ready. Trusted bootstrap utilities temporarily inherit fd198.
This is not a claim that only one process ever held the capability.

Only `trusted-ingress-boundary` can run in this launch profile. Its exact ten
helper hashes and nonce are bound to the private startup packet. PID1 passes
fd198 only to that fixed child and closes its own copy immediately after spawn.
The child makes the socket noninheritable; app-server and executor launches do
not receive it. Default profiles continue to close every nonstandard fd.

The basic measurement inventory now contains 21 capsule source files. Socket
broker cleanup and capsule process cleanup remain separate evidence domains.
This profile does not transfer arbitrary descriptors through systemd-run,
authenticate a client, enable external networking or establish a production
transport. Existing actual results retain their archived source identities.

## Additive HTTP profile (implementation pending actual validation)

The distinct literal `--trusted-http-ingress-fd` bootstrap selects only
`trusted-http-ingress-boundary`. It preserves the same verified FD198 through
pivot, adds four readonly runtime helpers only in this image, and exposes a
separate `trustedHttpIngressBoundary` map of fourteen hashes. The original
ten-hash ingress metadata remains unchanged. Cross-selecting either mode with
the other bootstrap profile is refused before dispatch; no frame can choose
an FD, command, image path or alternate destination.

The new child receives the same private startup packet and original
180/200/5-second and 8MiB limits. PID1 closes its FD198 copy immediately after
the fixed child spawn. The HTTP worker gate selects a separate readonly marker
and literal post-sandbox trampoline; network policy, home denial, namespace
checks, seccomp and closure of nonstandard worker descriptors remain enforced.

The ordinary capsule inventory remains 21 files; this conditional HTTP image
adds four files. Dedicated launcher/measure inventories include their own
additional dependencies separately. This source extension has no actual HTTP
capsule, systemd HTTP, CLI proxy, authentication or external-egress credit yet.
# HTTP-only loopback bootstrap

The first HTTP capsule attempt failed with FIXED_CLIENT_CONNECT_FAILED before
worker startup. Its generic error did not retain errno or interface flags, so
the previously missing loopback activation is a source diagnosis rather than
an observed cause of that historical run. That FAIL remains unchanged.

The explicit HTTP profile now activates only its own `lo`, after the capsule
sandbox checks and before any child starts. PID1, a one-user current-user map,
the loopback-only interface list, and NS_GET_USERNS ownership equal to the
current user namespace are prerequisites. Fixed SIOCGIFFLAGS/SIOCSIFFLAGS calls
add IFF_UP without selecting another interface, address or route. Actual flags
and namespace identity are emitted as trustedHttpLoopback before START. The
ordinary capsule profiles do not run this bootstrap. No external connectivity,
authenticated transport, worker network access or systemd HTTP credit follows
from the implementation alone.
# Separate stock CLI proxy-refusal profile (implementation in progress)

The explicit `--cli-proxy-refusal` bootstrap preserves no nonstdio descriptors
and selects only `cli-proxy-refusal`. It conditionally copies three new helpers
and binds the seven existing environment helpers plus these three in START.
It uses the same mapped-user/kernel-owned loopback bootstrap as the authored
HTTP profile, but does not inherit FD198 or claim a broker handoff. Cross-profile
dispatch, caller argv, nonce and scenario fields are refused. The new child is
intended to use the reviewed metadata thread-start operation and refuse a stock
CONNECT locally before TLS; no production launcher or auth operation is enabled.
Current implementation/test evidence is separate from the archived basic and
systemd authored HTTP runs, which preceded this supervisor revision.
# Fixed cgroup worker bootstrap

The additive `--trusted-cgroup-worker-boundary` shell/profile pair copies only the two new cgroup helper/child sources in addition to the default image. It closes every nonstandard FD across reexec, accepts only the matching start mode and ten exact helper hashes, and neither imports FD198 nor activates HTTP loopback. The original worker/control boundary ready records remain present; `trustedCgroupWorkerBoundary` separately binds its ten sources. The fixed child receives the original trusted-control startup packet after its own process has been pinned. Original job180s/command200s/kill5s/output8MiB limits and outer cleanup remain unchanged. This diagnostic obtains no auth, upstream, inference or general containment credit; actual integration evidence must be recorded separately.

# Candidate resource stress profiles (integration in progress)

The two explicit `--candidate-resource-stress-tasks` and `--candidate-resource-stress-memory` profiles close all nonstdio descriptors across reexec. They conditionally install three stress helpers and require eleven exact helper hashes. They cannot select another mode, import FD198, activate HTTP loopback, or supply a command, scenario, nonce or payload. The fixed child entry takes only `--inside-tasks` or `--inside-memory`.

Only these profiles keep their owned startup pipe open after the original supervisor-generated startup packet. Subsequent trusted control frames select canonical `start`, `ramp` (memory only), `release`, or `cancel` bytes. A single bounded partial write blocks the next action. `stress_action_delivered` records completed pipe delivery only: it explicitly does not attest worker acknowledgement or external observer admission. The new child protocol and external observer must validate those separate conditions before further workload release. Old profiles retain their original startup EOF. Inner job/command/grace/output limits and namespace cleanup are unchanged.

The source implementation and mock tests do not constitute a runnable, source-reviewed stress experiment. Child, gate, systemd OOM policy, external observer coordination and host/ancestor capacity prerequisites must all be integrated and verified before any actual allocation or fork workload. No resource exhaustion, auth, upstream or inference credit is assigned here.


### Explicit trusted CLI / isolated worker capsule mode

--trusted-cli-worker-boundary is a separate exclusive profile. Its twelve exact
helper hashes combine the existing trusted-control eight with local refusal,
CLI provenance and the new combined child/probe. Only this shell selector copies
those four extra files. All nonstdio inherited descriptors close before reexec;
there is no outer ingress descriptor198. Loopback is enabled only inside the
existing private network namespace. No upstream transport or credentials enter.

START must bind the exact image hashes. PID1 spawns only the fixed isolated
Python child after capability drop, with close_fds=True and empty pass_fds. Its
startup packet binds PID1-owned FIFO/namespace identities after own pidfd pin,
using the same trusted-control writer and known-close checks. Deadlines and
8MiB output limit remain unchanged. Other profiles cannot select this mode.

Scoped supervisor/legacy tests:100 PASS v2; v1 retained two test-fixture failures
from loops that had not yet classified the new explicit mode. Independent source
review PASS: scratch/session8-trusted-cli-worker-supervisor-source-review.md.
The complete child/measure integration and any actual run require separate
validation; this wiring alone does not prove tool routing or authentication.
