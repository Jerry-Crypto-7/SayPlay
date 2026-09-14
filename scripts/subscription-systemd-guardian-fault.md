# Own-unit guardian fault: actual runtime trigger, limited escalation evidence

This explicit `--run` probe uses the existing credential-free fixed CLI capsule
in one uniquely named systemd user unit. It changes no frozen capsule code,
credentials, model/effort or production settings. Candidate resources remain
2 GiB memory, zero swap and 64 tasks. The outer **15-second RuntimeMaxSec and
2-second TimeoutStopSec are synthetic fixture settings**. Inner command/job/
grace settings remain 200/180/5 seconds. This is not production 200s/5s proof.

Before dispatch it archives unit name, exact command and source hashes. After
the capsule's fixed stopped-CLI fixture is ready, it reads only its own UUID
cgroup's processes. It pins each candidate with pidfd, then verifies membership,
namespace PID sequence, executable and start ticks. Exactly one own namespace
PID1 with executable `/usr/bin/python3` must match. Its identity is checked
again before pidfd SIGSTOP; ambiguous or unreadable identity sends no stop
signal. No foreign PID, process group, cgroup or session is selected.

The observed stopped state is archived while the systemd manager outside the
leaf remains able to act. The driver has a 45-second absolute ceiling; its
fallback stop targets only the own unit and makes the result fail with
externalHarnessCleanup=true. Successful process cleanup must originate from
the manager, followed by own leaf absence and ESRCH on all pinned descriptors.
The failed unit is intentionally not auto-collected: this preserves Result,
configured timers and exit properties. Only after leaf removal does the driver
reset the exact own failed unit's metadata, then verify LoadState=not-found.

```text
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-guardian-fault.py --run
python -B scripts/__tests__/subscription-systemd-guardian-fault.test.py
```

## Actual first run and what it does not prove

`scratch/session7-systemd-guardian-codex-cli-resource-f52817c46afb4279a4f6ceca2c9169db.service.json`:

- Own capsule PID1 498, NSpid `[498,1]`, executable `/usr/bin/python3`, start
  ticks 11967 and exact cgroup were verified after pidfd pin and rechecked.
  SIGSTOP changed state S to T. The actual CLI was separately in its fixed
  stopped-CLI fixture. No unverified process was signaled.
- Systemd recorded **Result=timeout**, RuntimeMaxUSec=15s,
  TimeoutStopUSec=2s, KillMode=control-group. All six pinned descriptors returned
  ESRCH. Own leaf was absent before the metadata reset, which returned zero;
  own unit was then not found. Driver process cleanup was not invoked.
- Elapsed driver time was **16063 ms**. The raw stream includes a subsequent
  capsule **LEASE_EXPIRED** terminal with namespace cleanup verified and
  `killSent:false`. Thus the inner supervisor resumed after its stop and
  contributed to cleanup. Systemd's usual SIGCONT during stop is consistent
  with this observation, but the probe did not separately trace that signal.
  The behavior is documented in the [systemd v255 kill procedure](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.kill.xml).
- Therefore this proves the manager runtime deadline triggers removal after a
  stalled own capsule, **not actual 2-second KILL escalation or a capsule that
  remained permanently unresponsive**. Configured TimeoutStopSec is not a
  measurement of that escalation. The report's factual-check PASS must be read
  with this limitation; `capsuleCleanup:UNKNOWN` is conservative outer credit,
  while the actual inner terminal is preserved unchanged in `frames`.

All production readiness/auth/network/cleanup credit remains false/NOT_RUN.
No guardian KILL-exhaustion credit is inferred. A separate fixed worker that
continues ignoring TERM after CONT would be needed to force and measure the
2-second escalation, with its own explicit synthetic scope. This run is not
silently changed to that different experiment.

Offline validator tests: **6/6 PASS**, including missing own identity → no
SIGSTOP, wrong manager/timer evidence, external cleanup and missing ESRCH.

After the first actual run, the result contract was clarified with explicit
`guardianKillEscalation:NOT_OBSERVED`, `sustainedUnresponsiveKill:NOT_VALIDATED`
and `scope:manager-runtime-trigger-and-owned-cleanup-only`. The current driver
also separately records observed capsule terminals and resumed-after-stop
status. This is a disclosure-only follow-up; no command or signal behavior
changed, and the original raw report/source hashes remain unchanged. The
current-source index is `scratch/session7-systemd-guardian-summary-v2.json`.

An additional root review tightened the evidence validator: both source maps
must have the exact eight nonempty source entries and valid SHA-256 values;
missing/empty maps cannot establish stability. Before/after identities must
match PID, start ticks, namespace PID sequence, cgroup and executable, the
observed after-state must actually be T, and both identities must bind to the
report's own UUID unit and captured leaf. Arbitrary self-reported cgroups are
rejected. **9/9 validator tests PASS**; the original raw report passes a separate
offline revalidation in `scratch/session7-systemd-guardian-revalidation-v3.json`.
This is no new runtime measurement. Original raw/source identities remain
unchanged; current source and scope are in summary-v3.
