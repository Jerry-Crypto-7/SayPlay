# Trusted control boundary parent

This new parent has a runnable fixed Linux-only main, concurrent app-server and
executor driver and pure external replay validator. No runtime has been performed
by this implementation step; shared integration and review remain prerequisites.
It implements the fixed initialization-only app-server profile, exclusive authored
HOME/sentinel, startup identity packet admission, actual pipe identity capture,
atomic marker publication and the separate fixed executor protocol parser.

The fixed HOME is `/work/environment-appserver-home`; the authored sentinel is
`sentinel` beneath it. No authentication or environment TOML is created. App-server
requests stop after initialize/initialized: no thread, turn, tool or model call.
The eventual separate worker is not an app-server tool invocation.

PID1 must provide exactly one private startup-pipe JSON packet of at most 4096
bytes including its newline, followed by EOF, within two seconds of the shared
30-second parent budget. It binds actual outer control/output FIFO metadata and
PID/mount namespace identities from the same supervisor readiness observation.
The packet's source string is not an attestation. External evaluation must call
`packet_matches_ready` with the actual independently received workerBoundary;
the parent's own namespace equality is necessary but insufficient alone.
No nondumpable setting is relaxed and no outer `/proc/1/fd` is read by this parent.

After app-server pipes exist, the marker combines those two actual FIFO identities
with the two outer FIFO identities and authored HOME/sentinel identities. All
four pipe tuples must differ. `/work/trusted-control-boundary.json` is published
without overwriting an existing path. File mode is not readonly mount evidence.
The future fixed managed sandbox must grant an exact readonly file bind outside
the writable worker directory and explicitly deny the app-server HOME.

The only gate command is Python's fixed `--trusted-control-boundary`
entry. Missing `control_start_request()` fails closed; another probe is never
substituted. That separately owned gate profile and trampoline are dependencies.
Worker report validation requires the externally
bound marker; no report is validated against a marker invented by its worker.

The initial offline helper tests recorded 16 PASS in
`scratch/session8-trusted-control-parent-helper-unit.xml`. They cover exact packet
types, external identity mismatch, startup EOF/deadline/size/namespace checks,
initialize-only serialization, missing gate dependency and protected pipe alias
rejection. The full protocol/identity/cleanup replay and simulated driver tests
recorded 49 PASS in `scratch/session8-trusted-control-parent-full-unit-v2.xml`.
They do not establish actual runtime isolation.

## Fixed lifecycle and evidence

The shared 30-second clock starts before helper hashing and startup admission.
Protocol work stops at 22 seconds, reserving the remaining eight seconds for the
existing direct-child EOF 2s → own pidfd TERM 5s → KILL 1s policy. No deadline is
extended. The parent samples app-server liveness and pipe/object/marker identities
before starting the fixed worker and after the completed actual probe reply. It
also polls app-server exit while the worker is active. These observations are not
a durable liveness attestation. Both stdin streams close only after completion
or failure. Setup/selector failures retain the first error and attempt bounded
owned cleanup; unknown cleanup never becomes success or authorizes another job.

Raw app-server and gate stdout/stderr are archived separately from the decoded
worker probe body. The parent reuses `policy.MAX_OUTPUT`, **128 KiB total** across
both children; the outer capsule's separate 8 MiB limit does not replace it.
Observed counts include rejected known bytes. This report is emitted
only after cleanup, so there is no asynchronous late-evidence callback. Missing
EOF or unknown reaping fails. Each direct child may exit naturally with zero and
no signal, or be reaped as -15 after a successful own pidfd TERM at least two
seconds after EOF. ESRCH, -9, external or unknown signal provenance, and a zero
exit racing a sent signal are rejected. A successful send is not a handler ACK.
Outer PID1 still independently verifies descendants and namespace cleanup.

`validate_report(report, policy, gate, probe, expected_worker_boundary)` requires
the independently received actual `ready.workerBoundary`. It replays exact fixed
requests and observed raw responses, validates the complete worker report against
the parent's bound marker, and compares the worker's marker file identity/hash to
the published parent's file. Internal main validation checks only consistency of
the received startup packet; it cannot replace this external comparison.
The exact eight helper hashes include the old executor probe because it remains
part of the shared gate/image dependency, plus gate, trampoline, new boundary
probe, lockdown, noenv policy, model catalog and this parent. Before/after hashes
must agree. No model, auth, tool-invocation, aggregate resource or production
readiness credit is assigned.

Final scoped offline suite: 51 PASS in
`scratch/session8-trusted-control-parent-full-unit-v4.xml`, including shared
cross-child output-limit accounting and published marker inode mismatch.
An independent follow-up tightened replay comparisons to canonical JSON so a
queued boolean cannot be substituted by Python's equal integer. The resulting
52 PASS suite is `scratch/session8-trusted-control-parent-full-unit-v5.xml`.

## Cursor correction after preserved systemd failure

The first actual combined systemd run remains FAIL. Its immutable artifact is
`scratch/session8-cli-trusted-control-boundary-measure-f03be43d-879f-490e-af71-0934fdedb0a2.json`
(SHA-256 `09aeecd900e2d6c7df22992599327aabee91190ecc5b1ce3d748e57109dc31f6`).
The bounded offline diagnosis is
`scratch/session8-trusted-systemd-cursor-diagnosis.json`: 27 queued reads used
`afterSeq:null`; 26 complete replies repeated chunk sequence 1, 3379 decoded bytes,
`nextSeq:2`, without closure. App-server 455 plus executor 130970 observed bytes
crossed the unchanged 131072-byte parent cap. The earlier 8 MiB wording in this
document described the wrong layer and has been corrected; no code limit changed.

Pinned `codex-rs/exec-server/src/local_process.rs` at commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`, lines 373–435, filters retained output
by `seq > afterSeq`. A nonempty result returns immediately despite `waitMs:1000`.
With fixed `maxBytes`, `nextSeq` is the final included chunk's sequence plus one.
The pinned collection helper at line 1558 advances via `nextSeq - 1`.
The local verified source archive is
`scratch/session8-worker-executor-source/codex-rs__exec-server__src__local_process.rs`.

Only this parent's subsequent reads now use the last validated response cursor.
Notifications never advance it, preventing a higher notification from skipping
earlier retained output. Read chunks must be strictly above the requested cursor
and ordered; nonempty replies must report exactly last included sequence plus
one. Regressing, boolean, unsafe or skipping cursors fail before another request
is queued. Empty replies may advance over the shared terminal-event sequence
space; output-only contiguous sequence numbers are not required. Notification
and read copies still deduplicate with byte/stream identity checks.

The existing gate builder already supports this cursor, so gate and historical
direct profiles were not modified. No runtime retry occurred during this fix.
62 parent tests PASS in `scratch/session8-trusted-control-cursor-unit.xml`, including
notification races, partial retained reads, duplicate rejection and the historical
3379-byte repeated-output shape. This is offline verification, not a relabelled
actual success.
