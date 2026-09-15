# Candidate resource stress observer — retained component, unintegrated

This component implements concrete retained metadata and pidfd observation. It creates no systemd unit, launches no workload, writes no release packet, changes no cgroup byte, and never terminates a process. It grants no overall stress/exhaustion PASS or remote cleanup credit. Its command-line entry refuses operation. All validation so far uses OS mocks; Linux/systemd/workload/auth/network runtime is NOT_RUN.

## Fixed API

`create_observer(absolute_deadline, expected_source_hashes)` requires exactly three SHA256 keys: `subscription-candidate-resource-events.py`, `subscription-systemd-fixture-transport.py`, and `subscription-systemd-cli-probe.py`. Fixed sibling sources are read with no-follow bounded regular-file admission, hashed before compilation, and compiled from those exact captured bytes into private module instances. No caller module, path, unit, PID, command or limit is accepted. This is trusted-workspace expected-hash admission, not proof of a deployed read-only image or an interpreter's executed-byte identity.

The returned observer exposes its factory-generated `unit` from `create_event_reader()`. A future coordinator must create exactly this own UUID unit using the reviewed envelope. `open()` pins the private systemd manager, rechecks its generation/cgroup, reuses the reviewed relay MainPID/parent/private-peer binding and exact candidate readback, pins MainPID, and captures the retained-events baseline. The additional fixed systemctl property must be exactly `OOMPolicy=continue`; the reader independently requires `memory.oom.group=0`, 2 GiB memory, swap 0 and tasks 64. No manager signal except pidfd signal 0 is used.

`admit_workers(held_identity)` accepts exactly the projection `{phase, workerIdentity, childIdentities}` from the actual worker's held packet. `phase` is tasks or memory. Worker identity is `{pid, startTicks, pidNamespace, procInitPidNamespace}`; child identities are `{pid,startTicks}`. Decimal and namespace strings are canonical/bounded, PIDs are positive integers (not booleans), identities are distinct, and memory phase requires exactly two allocators. The worker's PID and proc-init namespace must match. This matches worker revision `d3e5cda4ec36ea49c76f18d9baa1a84a848e40bdf5dc0277fe114f4b83a4a095`; no final-report fallback is permitted.

Host candidates come solely from the retained, identity-checked own leaf's cgroup.procs sample. For each candidate the observer reads bounded fixed `/proc/PID/stat`, status NSpid and cgroup metadata, and PID namespace readlink. The host NSpid first value must be the candidate host PID; its last value, start ticks and namespace must match the actual held worker identity. Only matching candidates receive retained pidfds. Metadata is re-read after pinning; a second verified leaf sample must still contain every selected host PID, and each pin/generation/namespace is rechecked before admission. No global process scan or caller host-PID fallback exists. Even a known pinned generation that leaves the leaf is rejected.

The returned receipt says `releaseAdmitted: true` only for this component's identity/readback checks; `releaseWritten: false` and `exhaustionValidated: false` are explicit. It does not authorize an arbitrary workload command, prove capacity admission, or replace external worker-protocol and marker validation. The actual held packet transport/source identity and fixed release write are still coordinator integration work.

`sample()` retains copied event evidence and rechecks control identity/MainPID liveness. `observe_outcomes()` polls only retained worker pidfds, with no waitpid/reaping or signal. A readable pin records `pidfdExitObserved`; no return code or OOM victim attribution is invented. Unexpected poll flags fail closed, including unimplemented post-reap event combinations. `returnCode` remains null and `reapedByObserver` false. A future coordinator must reconcile actual worker-owned reap outcomes, kernel events and its own process lifecycle.

`close()` attempts every owned retained pin and the reader's handles, including after partial admission failure. Unknown close, read, identity or timing results are sticky and fence subsequent factories in the module instance. No failed close is retried against a potentially reused numeric FD. Caller must close after standalone sample/admission/outcome failure. Returned control/source/worker dictionaries are copies and do not alias the retained private baseline.

## Timing and limitations

One absolute monotonic deadline, at most 180 seconds from factory entry, covers source admission, metadata and final receipts/cleanup. The private relay's fixed systemctl calls are clamped to the remaining deadline and capped at two seconds. Existing private-manager socket metadata operations retain their reviewed one-second socket bound and are followed by deadline checks. Synchronous source/proc/cgroup I/O and inherited relay helpers cannot preempt a stuck kernel call; this component does not claim hard termination independently of the existing outer guardian. Every successful result is sealed after its report copies; final close also checks the absolute deadline and fences a late result.

Sequential path/PID/cgroup observations are not an atomic guarantee against privileged concurrent mutation. The integration must establish the trusted host PID/cgroup namespace, read-only source image, observer/manager placement outside the leaf, exact unit creation with OOMPolicy, fixed worker sandbox/marker protocol, pre-release capacity, bounded resource workload, event attribution, and own unit/leaf/process cleanup. None of those missing orchestration steps receives credit merely from this reader or its `releaseAdmitted` field.

## Scoped validation

`subscription-candidate-resource-stress-observer.test.py`: v1 21 PASS; v2 24 PASS in 0.53 seconds, XML `scratch/session8-resource-stress-observer-unit-v2.xml`. Tests cover own-leaf discovery, actual parser NSpid/cgroup mapping, namespace/generation/duplicate/fresh-proc rejection, membership drift after pinning, manager/MainPID/OOMPolicy failure, post-pin setup cleanup, copied-return alias safety, retained exit observation, fixed query/timeout, source mismatch before compile, sticky close failure, delayed close and delayed release-report copy. These mocks provide no actual exhaustion, kernel pidfd, release, systemd or production evidence.

Review correction after initial e0617921 source freeze: live worker admission now rejects Z/X/x stat states and requires no retained pidfd readiness before and after final identity checks. Signal 0 alone is not treated as proof of a non-exited worker. Outcome observation remains a separate exit-reporting operation. Six zombie/readiness/error regressions added; v3 30 mocked PASS (`scratch/session8-resource-stress-observer-unit-v3.xml`). No runtime used the prior revision.


### Retained pidfd readiness after parent reap

The outcome observer accepts exactly one event for its retained owned pidfd,
with an integer mask POLLIN or POLLIN|POLLHUP. An empty list remains live. It
rejects HUP alone, other bits, booleans, foreign descriptors and duplicate events.
Admission still rejects any readiness. Exit readiness does not supply an exit
status, perform wait/reap, or independently prove an OOM victim. Those separate
worker wait records and cgroup oom_kill delta remain mandatory.

The first common-profile tasks actual passed, while memory retained its generic
observer failure. That raw error does not identify the HUP branch. This source
fix is independently justified and reviewed, not a reclassification of the FAIL.
