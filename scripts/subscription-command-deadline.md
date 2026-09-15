# Actual fixed 200-second command timeout probe

The explicit `--command-deadline` mode reuses the owned-unit guardian driver,
identity pinning, nonblocking control/output handling and cleanup recorder. It
does not replace the original `--run` 15s/2s guardian fixture. No arbitrary
command, unit, executable, budget, environment or credential path is accepted.

The unit's exact command remains the existing capsule launch:

```text
/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout --signal=TERM --kill-after=5 200 /usr/bin/unshare --user --map-current-user --keep-caps --mount --net --pid --fork /bin/sh /mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh
```

The outer own-UUID systemd user unit has candidate MemoryMax=2G,
MemorySwapMax=0, TasksMax=64, RuntimeMaxSec=220, TimeoutStopSec=5,
KillMode=control-group and WorkingDirectory=/. The outer manager must **not**
cause this timeout. The driver ceiling is 235 seconds; driver fallback stop
makes the measurement fail. Existing 180-second job/200-second command/
5-second grace constants are unchanged. No production auth/network operation
or model inference runs.

After the fixed actual stopped-CLI fixture is ready, the driver pins and
revalidates the own capsule PID1 and sends it SIGSTOP. This prevents its ordinary
180-second job timer from winning first. It also records systemd MainPID and
requires the corresponding pinned own-cgroup process to be `/usr/bin/timeout`.
Only the own leaf's process identities are inspected. No foreign PID or cgroup
is signaled or migrated.

The predeclared success conditions require:

- Systemd ExecMainCode=exited (numeric 1), ExecMainStatus=124, Result=exit-code;
  wrapper exit 124 is also checked, with any actual difference retained.
- At least 200 seconds between systemd's actual monotonic main-start and
  main-exit timestamps. Total harness wall time alone is insufficient.
- Exact configured outer 220s/5s resource unit, own pinned PID disappearance
  and leaf removal, no driver process cleanup, then exact own failed-unit
  metadata reset and LoadState=not-found.
- Stable complete source identities, validated own stopped PID1 and bound
  timeout main identity. An outer manager Result=timeout fails 200s evidence.

GNU timeout can resume stopped children as part of termination. Any subsequent
capsule terminal and resumed cleanup are preserved as actual facts. Success
does **not** establish a permanently unresponsive descendant's KILL escalation;
`sustainedUnresponsiveKill:NOT_VALIDATED` and guardian KILL escalation
NOT_OBSERVED remain explicit. The independent existing actual CLI 5s grace
test is different evidence.

```text
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-guardian-fault.py --command-deadline
python -B scripts/__tests__/subscription-command-deadline.test.py
```

The command lasts about four minutes and stores a unique
`scratch/session7-systemd-command-deadline-<unit>.json` before dispatch, after
identity/stop observations, and at completion. Original guardian reports and
their validator revalidation chronology remain unchanged.

Reference: [GNU timeout exit-status and termination semantics](https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html).

## First actual run: retain the predeclared failure

`scratch/session7-systemd-command-deadline-codex-cli-resource-f0c7e521450e42e2a1dc03cfc57f60fb.service.json`
did **not** meet the declared exit-124 success condition:

- The main process was `/usr/bin/timeout` PID451 in the own UUID leaf. The own
  capsule PID1 PID453 was pinned and verified as `/usr/bin/python3`, NSpid
  `[453,1]`, with matching start ticks/cgroup, then stopped (observed T).
- Systemd recorded Result=signal, ExecMainCode=2 and ExecMainStatus=9. Actual
  systemd-run wrapper status was **255**, not 124 or 137. Main start/exit
  monotonic timestamps were 819979288/1024986115 microseconds: **205006.827 ms**.
  Driver time was 205204 ms. Outer 220-second Result=timeout did not occur.
- Seven pinned own PIDs returned ESRCH, own leaf was absent before metadata
  reset, exact own reset-failed returned zero and the unit was then not found.
  No driver stop, driver error or source change occurred.
- No capsule terminal was received. The historical `capsuleResumedAfterStop`
  false field means no resumption evidence, not proof that it never resumed.
  Current code explicitly records `capsuleResumptionObserved:false` with
  `capsuleResumedAfterStop:null` when no terminal establishes resumption.

The outcome is consistent with GNU timeout's documented behavior when its own
process group receives its kill-after SIGKILL. The [upstream timeout source](https://raw.githubusercontent.com/coreutils/coreutils/master/src/timeout.c)
shows that path and its monitor-self-termination caveat. This explanation is an
inference from fixed command, timing and signal outcome; no independent trace
of the 200-second SIGTERM was captured. **The archived predeclared test remains
FAIL and commandTimeoutMeasured remains false.** It is not relabeled a passed
exit-124 experiment or production timeout validation.

## MainPID precondition chronology correction

In the first actual run, the pinned own inventory included the timeout process
before SIGSTOP, but the query binding it to systemd MainPID happened **after**
SIGSTOP. That report must not be described as a pre-fault manager-binding gate.
After root review, current code queries and validates MainPID through an
explicit pre-stop callback, rechecks its pinned identity, and rechecks the
target PID1 after the callback, all before sending SIGSTOP. Missing/wrong
MainPID or an unbound executable produces zero stop signals. No foreign PID
signal was observed in the original run.

The original raw report/source hashes remain unchanged. Offline tests now
cover the ordering guard; there has been no second four-minute run of that
changed ordering at this checkpoint. Current evidence is indexed in
`scratch/session7-systemd-command-deadline-summary.json`.

## Separately declared verbose diagnostic mode

`--command-deadline-diagnostic` makes one explicit diagnostic-only argv change:
it adds GNU timeout `--verbose` to a copy of the fixed capsule argv. It does
not mutate `candidate.CAPSULE`, the frozen CLI core or any time/resource limit.
The corrected MainPID gate runs before SIGSTOP. The old nonverbose exit-124
contract remains separate and cannot pass by switching to the new branch rules.

Before dispatch, the diagnostic records these success branches:

- TERM diagnostic receipt at or after 200000 ms, then graceful main exit124
  and wrapper124, with actual main duration at least200000 ms; or
- TERM followed by KILL receipt at or after205000 ms, receipt spacing in the
  explicitly allowed4500–6500 ms window, actual main duration at least205000 ms,
  manager Result=signal / code2 / status9 and actual systemd-run wrapper255.

Both require exact candidate outer220/5 configuration, no outer manager timeout,
the validated main/PID1 identity, stable source identities and owned cleanup
without driver stop. The receipt window accounts for driver scheduling; it is
not a tolerance applied to the main's actual minimum200/205-second lifetime.

Outer stderr is captured as at most64 KiB /128 base64 chunks with monotonic
receipt timestamps. The bounded parser reconstructs split lines and accepts
only GNUtimeout TERM/KILL sending diagnostics naming `/usr/bin/unshare`.
Diagnostics describe a sending attempt, **not target handler acknowledgement**.
They are distinct from the capsule's encoded child-output frames. Arbitrary
caller-provided report text is not cryptographically authenticated by this
offline validator.

```text
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-guardian-fault.py --command-deadline-diagnostic
python -B scripts/__tests__/subscription-command-deadline-diagnostic.test.py
```

The new diagnostic test file has 7 offline tests covering both declared branches,
missing/wrongly ordered markers, receipt times, main lifetime, outer timeout,
chunk limits, MainPID precondition evidence and preservation of the original
mode's failed exit-124 outcome. Results of the single new actual attempt are
recorded separately; this mode does not retroactively relabel its predecessor.

## Single actual verbose diagnostic result

`scratch/session7-systemd-command-deadline-diagnostic-codex-cli-resource-28fbe706878b43dd9ce0c5a784db239b.service.json`
passed the separately predeclared diagnostic contract. TERM receipt occurred at
200051.127 ms and KILL receipt at 205051.753 ms (5000.626 ms apart). Systemd main
duration was 205009.346 ms, Result=signal, ExecMainCode=2, ExecMainStatus=9;
the systemd-run wrapper returned 255. The outer 220-second manager timeout did
not occur. Driver duration was 205337 ms.

The corrected gate bound systemd MainPID 475 to its pinned `/usr/bin/timeout`
identity before SIGSTOP of own capsule PID1 477. Target state T was observed.
All seven pinned PIDs returned ESRCH, the own leaf disappeared before the exact
own failed-unit metadata reset, and the unit was then absent. No driver stop,
driver errors or runtime source changes occurred. No capsule terminal was
received: capsule resumption and capsule cleanup remain unknown.

After the actual source freeze, offline validation additionally required the
original and revalidated main identities to match pid, start ticks, namespace
PIDs, cgroup and executable. The runtime callback already made that comparison;
this change closes an offline report-completeness gap. A negative unit test
rejects individually valid identities with different start ticks. The immutable
actual report is separately revalidated with this stricter current source;
it is not presented as a new run. Guardian 9, original deadline 7 and diagnostic
7 tests pass. The original nonverbose FAIL remains unchanged.

The evidence index is
`scratch/session7-systemd-command-deadline-diagnostic-summary.json`.
This result proves the fixed verbose command deadline sending diagnostics and
owned cleanup for this synthetic candidate. It does not prove handler
acknowledgement, sustained-unresponsive KILL resistance, production auth/network
or production readiness.
