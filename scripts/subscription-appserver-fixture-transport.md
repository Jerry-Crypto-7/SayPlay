# Authored protocol fixture OS transport

`createAppServerFixtureTransport(scenario, observe?)` implements the existing
`GenerationTransportFactory`. Scenarios are exactly `normal`, `cancel` and
`output-limit`. It launches the fixed WSL clean-env CLI capsule and its fixed
local Python fixture, never an app-server model process or network endpoint.
The existing generation adapter owns the shared remaining job budget and its
permanent fence after unknown termination. Factory evidence explicitly reports
AUTHORED_PROTOCOL_FIXTURE, actualModelCalls=0 and productionReady=false.
Observed protocol turn events are authored events, not inference evidence.

The ready helper SHA is compared with locally read source before start; PID1
also compares the copied image SHA before spawning. The trusted existing capsule
retains its 180/200/5-second job/command/TERM budgets, 8 MiB output cap, private
synthetic config, no host HOME/mnt, loopback-only network and fixed hostname.
The basic launcher does not enforce an aggregate resource envelope.

Additional fixture input limits: cumulative 2 MiB, canonical base64 chunks of at
most 2048 decoded bytes, monotonically increasing seq, exactly one outstanding
chunk. PID1 acknowledges only after all chunk bytes have been written to the
nonblocking child pipe. Cancellation closes child stdin and uses the same pidfd
termination/reap path; a protocol ack never supplies process cleanup credit.
TS requires namespace-empty, all observed pidfds ESRCH, no signal errors and an
actual local close. Missing/malformed terminal leaves remote cleanup unknown.

Raw stdout and stderr arrive as separate Uint8Arrays. The transport retains no
raw bodies. For the interactive capsule modes, PID1 forwards the first actual chunk crossing
8 MiB (at most 4096 bytes), immediately marks OUTPUT_LIMIT and begins cleanup;
later excess bytes are counted/hashed but withheld. This lets the generation
adapter count the known rejected bytes while retaining at most 8 MiB. The
terminal's observed bytes may exceed delivered bytes during drain. A rejected
overlimit transcript is never described as a complete raw archive.

The optional `onOutputAccounting({observedBytes})` callback reports the validated
supervisor aggregate watermark after every queued raw callback, before cleanup
resolves. Missing or invalid terminal evidence reports `null`. A valid overflow
watermark can report wholly withheld bytes and trigger the generation adapter's
OUTPUT_LIMIT even without a raw crossing chunk. It never supplies synthetic
padding or changes `result.outputBytes` (received raw bytes). Deferred outputs
are drained before this ordering boundary even if terminal and local close
arrive in the same event-loop tick. Tests cover this race and count-only overflow.

Unit tests mock OS spawn and do not establish runtime containment. Actual
capsule execution requires a separate reviewed measurement and source receipt.

`createSystemdAppServerFixtureTransport` selects a second fixed launcher: the
credential-free Python systemd relay. No caller-supplied executable/path/env is
introduced. This factory requires exact candidate resource admission and bound
unit/leaf cleanup receipts in addition to ordinary capsule pidfd evidence. Its
final `aggregateResourcesValidated` flag concerns configuration/readback and
cleanup only; the receipt explicitly leaves candidate exhaustion unvalidated.
The basic factory still rejects unexpected systemd receipts and reports false.

Both authored-fixture factories require current SHA-256 hashes for the authored fixture
child and subscription-worker-lockdown.py in ready and the exact start frame.
Missing or changed lockdown identity prevents start. This binds copied sources;
actual installation and kernel behavior require separate runtime evidence.
The systemd receipt requires the sole private-socket-peer-v1 manager profile,
fixed own-UID socket path, five non-symlink directory/socket metadata components,
peer UID and generation, plus the existing full ready/terminal identity equality.
Pre-spawn failure `notSpawned` remains diagnostic only and grants no cleanup credit.

`createSystemdAppServerMetadataPipeTransport` is the third fixed export. It uses
the same OS relay, resource admission, queues, output accounting and cleanup,
with only the literal `--metadata-pipe` selector. Its start mode is
`appserver-metadata-pipe`, has no fixture scenario, and requires four current
copied-source hashes: metadata child, unchanged noenv policy helper, worker
lockdown and text-only catalog. Wrong helper sets or foreign started/terminal
modes fail closed. The historical `systemdFixtureBoundary` wire field remains
the shared resource receipt name; it does not make metadata an authored response.

The raw export reports `MetadataResourceEvidence.kind=ACTUAL_METADATA_PROTOCOL`.
It is a byte pipe: the metadata wrapper independently gates RPC before any pipe
write and the fixed Python child independently gates before actual CLI writes.
Neither raw receipts nor successful thread metadata permit a model turn, auth
operations or production readiness. Only complete bound cleanup sets aggregate
resource validation; ready alone cannot do so. The observer is called in the
same synchronous finish step before cleanup Promise continuations, following
all deferred raw callbacks and the final accounting watermark.

Current shared unit tests cover fixed argv, four-vs-two helper identity, absent
or malformed metadata boundaries, foreign modes, observation ordering and
readiness without terminal evidence. These are mocked OS tests; a new actual
systemd metadata measurement is required for runtime credit.

Subsequent systemd metadata expected-refusal runtime passed at
`scratch/session8-systemd-appserver-metadata-pipe-a3012abc-b48e-45be-b58e-8e86dd20f93d/summary.json`.
The authored fixture compatibility run after the profile refactor also passed
normal/cancel/output-limit at
`scratch/session8-systemd-appserver-fixture-ts-d078d76e-903f-40ac-a5a0-aa5dfb5ebea8/summary.json`.
Both retain their before/after source hashes and zero actual model calls.

Later executor development adds an optional, strict six-hash
`execServerWorkerBoundary` readiness object. Neither fixture nor metadata factory
selects the executor mode. This compatibility change postdates those actual
reports; it does not change their archived identities.
