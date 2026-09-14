# Trusted-control boundary measurement

Run this fixed no-argument wrapper only after the joint source review and runtime
handoff. It imports the exact hashed bytes of the existing basic capsule driver,
then adds one scenario to that private module instance and uses its existing
bounded pipe/heartbeat/start/terminal/cleanup loop. The shared basic driver remains
unchanged and does not independently enable this scenario. No second transport,
arbitrary command, environment override or alternate resource profile is added.

Start admission requires exactly the eight current helper hashes under
`trustedControlBoundary`, the actual outer worker namespace and control/output pipe
identities. Replay compiles the admitted parent, gate, policy and probe bytes and
calls `parent.validate_report(report, policy, gate, probe, ready.workerBoundary)`.
The private startup packet must therefore match independent supervisor ready
identity, not just its own source label. Full current source-before/after inventory
includes the wrapper, driver, parent, probe and every copied runtime helper.

The existing driver enforces terminal EXITED/child zero/wrapper zero, separate
stdout/stderr, complete stream EOF, output SHA/bytes, pidfd ESRCH, namespace empty,
no signal failure and no source drift. Parent replay independently requires its
actual app-server initialization, worker probe, live control observations and
bounded own direct cleanup. The authored test fixtures confer no runtime credit.

Each attempt has a unique prepared/final receipt and the driver's full artifact.
`parent-stdout.bin` preserves exact received parent bytes (at most 8 MiB). Complete
stdout is claimed only after successful EOF, byte count and SHA checks; a failed
attempt may contain only a prefix. JSON wire spelling is represented by the
existing parsed frames, not falsely called a byte-identical whole-wire transcript.
The parent's nested raw evidence remains in that stdout. This wrapper uses the
basic capsule: aggregate resources are NOT validated. Existing 180/200/5-second
and 8 MiB limits and the driver's local timeout remain unchanged; local process
exit alone never proves remote cleanup.

Scoped offline validation: 21 PASS. Independent parent fixtures cover valid full
replay, wrong source/helper/outer identity, profile confusion, malformed ready,
missing EOF, byte/hash mismatch and missing cleanup. No CLI, auth, network, model
inference or actual app-server tool invocation ran during implementation.

Predispatch identity tightening: namespaces require canonical positive inode
numbers without leading zeroes; descriptor inode zero and identical control/output
pipe identities are refused before any start bytes. Six dedicated negative cases
bring this scoped suite to 27 PASS. This closes the main source-review admission
gap; downstream rejection is no longer needed for these malformed ready values.
