# Trusted control boundary inside the private-peer systemd envelope

This is a separate credential-free integration measurement, not a production
launcher. The only relay selector is `--trusted-control-boundary`. It admits the
existing noninteractive `trusted-control-boundary` supervisor mode and its exact
eight-helper hash map; a scenario field, another mode, missing/extra/drifted helper
or interactive input is rejected before resource admission or pipe dispatch.
Existing fixture and metadata profiles retain their prior contracts.

The new wrapper composes `subscription-trusted-control-boundary.measure.py` with
the existing resource validators and `ObservedWire` from
`subscription-exec-environment-systemd.measure.py`. It does not clone the resource
broker, parent validator or namespace-cleanup validator. The compiled fixed
modules and the driver are bound to their loaded hashes, included with relay,
resource probe and all existing runtime sources in before/after evidence.

The fixed command uses clean WSL `/usr/bin/env -i`, fixed Python and the fixed
relay path. No command, environment or scenario can be supplied by the caller.
Before the eight-hash start is written, the observer requires exactly one owned
UUID receipt and the existing strict private socket peer, manager/main process
generation, outer manager/driver cgroup placement and resource readback checks.
Terminal evidence must retain the same identities, repeat the exact pre-start
readback and prove owned unit absence, leaf absence and systemd-run closure.
Independent supervisor namespace/process cleanup and the full parent/probe
replay must also pass, including startup packet equality with actual outer ready.

The configured candidate is 2 GiB memory, swap zero and 64 tasks. Existing inner
job/command/TERM-grace/guardian limits remain 180/200/5/220 seconds. The trusted
parent retains its own 30-second total budget with 22-second protocol work and
eight seconds reserved for cleanup. This new wrapper changes none of those
limits. A single fixed integration scenario is run; there is no retry loop.

The boundary probe's scope is the existing four HOME/sentinel paths and three
inner proc FD paths, metadata-only open attempts and protected-pipe separation.
Combining it with resource readback does **not** constitute a new cgroup escape
denial sweep, aggregate exhaustion test or general hostile-worker proof. The
receipt explicitly keeps `candidateExhaustionValidated:false` and
`newCgroupEscapeSweepPerformed:false`. No auth, inference, app-server tool-call
or production readiness credit is granted. Resource readback credit is set only
after the complete new integration passes.

Each invocation creates a fresh scratch UUID directory and prepared receipt
before dispatch. Bounded candidate wire lines are archived there; the existing
driver artifact retains parent raw bytes, typed frames and all failures.
Unread rejected overlong/overbudget lines are not called a complete transcript.
The wrapper does not delete owned or historical files and does not bypass ACLs.

Implementation validation: 146 PASS across the new wrapper and existing relay
tests in `scratch/session8-trusted-systemd-unit.xml`. These are offline fixtures;
no new systemd, app-server or worker runtime was performed in this step.
