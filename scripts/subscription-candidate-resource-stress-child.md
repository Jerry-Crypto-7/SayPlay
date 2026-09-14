# Fixed candidate stress child — not yet exercised

This new profile composes private, source-bound copies of the existing trusted
control parent, no-environment policy, exec-server gate, base marker validator,
and finite stress protocol. It accepts only `--inside-tasks` or
`--inside-memory` in the reviewed Linux capsule. The eleven helper hashes are
the previous eight trusted-control dependencies plus worker, protocol, and
this child. The readonly bytes compiled are the same bytes hashed before work;
all eleven are read and hashed again after owned cleanup.

The existing parent `run_parent`, `Session`, `Capture`, initialize-only
app-server, fixed HOME/sentinel/pipe marker, and bounded pidfd cleanup are
reused through a private module instance. The executor is a separate fixed
exec-server session. This is not an app-server model tool invocation. Shared
sources and historical profiles are unchanged. The child work limit remains
22 seconds and its total limit remains 30 seconds, including the two-second
startup allowance, source checks, cleanup, and bounded output writes.

Unlike the old parent profile, startup is the first actual JSONL packet on a
persistent private stdin pipe, without EOF. The packet receipt retains exactly
those bytes with `eofObserved:false`; it is never converted into an invented
old four-field stream that reached EOF. Its namespace identities must match
the current process. External replay requires the separately received
`ready.workerBoundary`, rather than accepting the packet as its own authority.

Subsequent stdin accepts only the worker's canonical start/ramp/release/cancel
JSONL bytes, at most 256 bytes total. A partial line does not authorize work.
Start may await the actual fixed process/start reply. Ramp and release require
the finite protocol's prior accepted write and actual worker progress. EOF or
cancel is never a successful release. The selector adapter consumes its own
control events and returns only ordinary session events to the original
parent loop; control failure enters that loop's owned cleanup path.

Each accepted held or ramp-complete worker record produces one actual stdout
JSONL wrapper:

```
{version:1,type:"candidate_stress_progress",phase,record,rawHex}
```

`rawHex` contains the exact worker JSONL bytes reconstructed from verified
process/read chunks, including its newline. It is checked against `record`.
Duplicate process/output notifications remain in the archived session wire
but do not produce duplicate progress. Progress is emitted before waiting for
the external observer's next canonical action. The observer should select the
actual held `{phase,workerIdentity,childIdentities}` fields, independently pin
its own leaf members, and archive its own admission receipt. Neither the
supervisor delivery nor `authorize_observer(action)` attests that receipt here.

The final JSONL uses `profile:"fixed-candidate-resource-stress-child"` and
contains the unnormalized new parent report, actual persistent-control receipt
and admission history, progress wrappers, complete finite protocol result,
eleven before/after hashes, and elapsed time. `validate_report(report,
(parent,policy,gate,base,protocol),expected_worker_boundary)` replays actual
initialize-only and exec-server wire, finite release ordering, worker terminal,
source equality, app-server lifetime, and owned direct cleanup. The old parent
validator is not used to relabel the new startup/protocol as an old success.

The existing 128 KiB shared captured-session budget also counts progress
wrappers. A final report is bounded to 2 MiB and total child stdout to 3 MiB;
these serialization caps do not increase the 128 KiB runtime capture budget.
Output is nonblocking and checks the shared deadline both after readiness and
after delivery. Unknown selector, stream, or pidfd close is sticky and fences
a subsequent invocation in the same module. Remaining owned handles are
still attempted. Parent failure cannot receive resource success.

`resourceEnforcementValidated:false` remains explicit: a complete workload
report is not proof of candidate 2 GiB or tasks64 enforcement. Independent
observer event deltas, host identity mapping, and unit/leaf cleanup remain
required outside this component. No credentials, external network, model
inference, host cgroup writes, or exhaustion runtime were used in these tests.

Offline tests use authored responses and mocked kernel/session operations.
The initial v1 run retained 20 fixture-loader failures (duplicate `.py` suffix)
and nine passes; v2 had 29 passes. v3 retained two unhashable fake-handle
failures and 30 passes; v4 had 32 passes. These are not actual stress results.

The reviewed composition correction closes an allocated selector when its
initial control registration fails, retaining the original error and sticky
unknown-close evidence. The v6 suite has 36 passes, including full 50- and
64-child authored terminal replay. These larger lossless reports exceed the
old relay's 128 KiB serialization aggregate even though captured session bytes
remain below 128 KiB. The relay integration must use the already declared
3 MiB serialized child-output aggregate and 2 MiB final-record cap; neither
the captured-session limit nor any workload/resource/time budget changes.
