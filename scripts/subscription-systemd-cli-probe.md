# Candidate systemd resource envelope around the existing CLI capsule

`subscription-systemd-cli-probe.py` runs the **same fixed credential-free CLI
capsule command** inside an own unique transient systemd user service. It accepts
only `version`, `private-sentinel` or `stopped-cli`. No command path, unit name,
credentials, prompt, environment or budget override is accepted.

The outer candidate configuration is MemoryMax=2G, MemorySwapMax=0, TasksMax=64,
RuntimeMaxSec=220, TimeoutStopSec=5, KillMode=control-group, WorkingDirectory=/.
The existing inner `/usr/bin/timeout --signal=TERM --kill-after=5 200` and
capsule's 180-second job deadline, 5-second grace and 8 MiB output cap remain
unchanged. The 220-second setting is an additional guardian ceiling, not a
production deadline change. The capsule's tmpfs/runtime allocations, PID1 and
CLI descendants are all charged to this leaf; **there is no supervisor RAM
reserve inside the leaf**. Systemd is its guardian outside the resource leaf.

The host driver uses a clean explicit environment for access to the current
user's manager. The capsule itself starts with `/usr/bin/env -i PATH=/usr/bin:/bin`.
No host cwd, home, user bus socket, writable cgroup path or credentials are
deliberately passed into the pivoted capsule. The existing capsule owns its
mount/PID/network isolation and protocol; this driver does not replace or
change it. Host metadata reads are restricted to this invocation's own UUID
leaf, opened using descriptor-relative no-follow traversal. It never writes
cgroup limits or migrates PIDs; systemd configures only the own transient unit.

Every attempt archives configuration and source hashes **before dispatch**.
On capsule readiness, before sending start, the driver reads back own-leaf
memory/swap/pids settings and accounting/events. Stopped-CLI readiness captures
a second sample. Existing capsule transcript and scenario validators check
terminal integrity, actual CLI stop/cancel identity, grace/KILL and owned
namespace cleanup. Final outer cleanup additionally requires the exact unit
to be collected and its leaf to be absent. Missing observations fail closed.
These are current observations, not cryptographic report attestation.

```text
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-cli-probe.py version
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-cli-probe.py private-sentinel
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-cli-probe.py stopped-cli
python -B scripts/__tests__/subscription-systemd-cli-probe.test.py
```

## Actual session 7 result

All three candidate-envelope scenarios passed, with source hashes unchanged
within each run, exact 2 GiB/0 swap/64 tasks readback, capsule scenario and
transcript checks passing, and own-unit collection/leaf removal verified:

- Version: `scratch/session7-systemd-cli-version-codex-cli-resource-414e6aeadcb6488d9fe20f3da6e741d5.service.json`.
- Synthetic private sentinel: `scratch/session7-systemd-cli-private-sentinel-codex-cli-resource-c2621da08f9348aa857cbf2d817f0a08.service.json`.
- Actual owned pinned CLI SIGSTOP then cancel: `scratch/session7-systemd-cli-stopped-cli-codex-cli-resource-97bdf9dc6d894f099560fd29706660fe.service.json`.

The resource-only synthetic fixture separately demonstrated fork/OOM
enforcement at **64 MiB/16 tasks**. That measurement must not be presented as
an actual 2 GiB/64 task exhaustion test; the CLI integration demonstrates
readback and bounded normal/private/cancel lifecycle in the candidate envelope.

`productionReady:false`, production auth/network/cleanup NOT_RUN remain in
every report. The raw resource fixture's writable cgroup observations remain
FAIL and are not erased by this integration. The capsule has no `/sys` mount,
but hostile descendant namespace escape, inherited descriptor exposure, full
guardian disconnect/OOM/failure cleanup, and authenticated production behavior
still require separate validation. These results do not authorize credential
reads or inference, and do not change model, effort, subscription or production
resource settings.

### Review follow-up: fail before dispatch on wrong readable limits

The original three runs read the limits before start but evaluated exact values
only after completion. Review identified this as a pre-dispatch guard defect.
The current driver checks the exact own leaf, memory.max=2147483648,
memory.swap.max=0 and pids.max=64 **before enqueueing any start frame**. Missing
or readable-but-wrong values raise a failure and do not dispatch the child.
This check is a current readback, not an atomic guarantee against later host
changes to cgroup settings.

Regression tests now include zero start frames for each wrong/missing field:
**9/9 PASS**. One new actual version run passed with the current guard:
`scratch/session7-systemd-cli-version-codex-cli-resource-9a4da4d1afcd4eb7a06d57addade0e76.service.json`.
It verified transcript/capsule checks, candidate limits and own leaf removal.
Historical private/cancel runs remain valid observations of their archived
source, and were not relabeled as runs of the new guard. The new evidence index
is `scratch/session7-systemd-cli-summary-v2.json`; the original index is retained.
