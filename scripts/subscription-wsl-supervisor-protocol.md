# Offline WSL supervisor protocol v1

This is a fixed-DUMMY implementation and fault experiment. It does not launch
Codex, inspect login state, access credentials, or enable production inference.
The existing `codex-subscription.ts` transport remains separate.

The subsequent [credential-free actual CLI runtime probe](subscription-runtime-probe.md)
is also separate. Its final pinned Linux CLI help/version and fixed synthetic
sandbox checks pass after retained UID/device/setup failures. Auth/network/production cleanup remain NOT_RUN;
neither that probe nor this dummy protocol enables production inference.

## Ownership and launch boundary

`subscription-wsl-supervisor.sh` runs inside explicit user, mount, network and PID
namespaces. It builds a copied system Python/setpriv runtime in tmpfs, remounts
`/usr` read-only and enters a chroot. No host `/home` or `/mnt` exists there. The
only host write capability is pre-opened FD 3 to the designated scratch audit.
The supervisor asserts PID 1 and an initially empty namespace, read-only `/usr`
and a network namespace containing only `lo` before accepting a request.

The child has no effective capabilities, an empty capability bounding set and
`NoNewPrivs=1`. The supervisor is nondumpable. The fixture verifies that the child
cannot reopen `/proc/1/fd/3`. Children do not inherit FD 3. This prevents the audit
being treated as safe merely because child stdout is wrapped.

All executable names and child source are fixed in the supervisor. The protocol
does not accept a binary path, shell command, PID or PGID. The filesystem paths
in the shell launcher deliberately allow only this machine's designated script
and scratch subtree. This is not a general remote process management interface.

## Control input and output

Windows keeps supervisor stdin open. Every control frame is one UTF-8 JSON line:

```json
{"version":1,"op":"start","mode":"normal","payload":"synthetic source"}
{"version":1,"op":"keepalive"}
{"version":1,"op":"cancel"}
```

Only one start is accepted. Modes are `normal`, `sleep`, `ignore_term`, `setsid`,
`zombie`, `backpressure`, `stdin_backpressure` and `stdin_setup_failure`; each
selects fixed dummy behavior. Extra keys and
unknown operations are rejected. The dummy receives only `payload` on its own
stdin followed by EOF. EOF on the supervisor control stream requests cleanup.

The supervisor emits versioned frames:

| Type | Meaning |
|---|---|
| `supervisor_ready` | Sandbox validation completed; contains `leaseMs` and sandbox facts. |
| `job_ready` | Fixed dummy parent and descendant exist; includes `/proc` snapshots. |
| `child_output` | `{stream:"stdout"|"stderr",text:string}`; opaque child data. |
| `supervisor_error` | Sanitized error class; never evidence of successful cleanup. |
| `supervisor_terminal` | Reason, process evidence and cleanup result, emitted after cleanup. |

Never recursively interpret `child_output.text` as a supervisor frame. A child
fixture intentionally prints a fake `supervisor_terminal`, which remains child
data. UTF-8 decoding is incremental across read boundaries. Buffered tail output
is drained after reaping writers and before the terminal acknowledgement.

Terminal reasons include `completed`, `cancelled`, `input_eof`, `lease_expired`,
`start_deadline`, `job_deadline`, `stdout_backpressure` and `supervisor_error`.
The terminal contains `cleanup.owner`, `verified`, `before`, `observedStates`,
`after`, `observedPidsESRCH`, `allObservedPidsESRCH`, `signals`, child reap statuses
and `directChildReturnCode`. `externalHarnessCleanup` must be false. Optional
delivery information has `backpressure`, `stdoutClosed` and `queuedBytes`.
Optional `childInput` evidence records `totalBytes`, `writtenBytes`, `pendingBytes`,
`closed` and `pipeCapacityBytes`. Written bytes mean accepted by the OS pipe, not
proof that the child consumed or interpreted them.
`closed:true` means no child input channel remains open, including cancellation
before start when all byte counts are zero and no child exists.

## Cleanup proof and delivery

The owned child process group receives TERM. PID fds additionally cover every
observed descendant in this exclusive PID namespace, including a descendant
that calls `setsid`. After the grace period, surviving owned handles receive
KILL. PID 1 reaps adopted children. Evidence records actual `S`, `R` or `Z` states,
then requires an empty namespace and ESRCH for every observed PID. The test
process does not perform a second cleanup and credit that cleanup to cancel.

Live stdout uses a nonblocking bounded queue. An attached wrapper that stops
reading cannot block control/lease processing in stdout flush. Backpressure
triggers cleanup; the authoritative audit acknowledgement can exist even when
the live pipe never delivers it. The backpressure test observes the audit while
Windows stdout remains paused and resumes reading only afterwards.

A caller that has lost the live terminal must report remote cleanup as unknown,
even when an independent experiment can later read a verified audit result.
Wrapper-disconnect and backpressure reports explicitly distinguish these facts.
The audit uses local file writes/fsync; blocked or failed storage is not covered
by the stdout backpressure guarantee.

Child stdin is also nonblocking: one bounded payload queue is serviced in chunks
of at most 4 KiB by selector write readiness, alongside control and child output.
EOF is sent only after all payload bytes have been written, or during cleanup;
broken child input is a supervisor error rather than successful delivery.
Partial setup failures still close stdin and run owned descendant cleanup.
`stdin_setup_failure` raises a fixed exception after Popen creates the direct child
but before stdin is configured or registered. Its terminal must report an error,
zero written bytes, closed input and verified cleanup of at least that direct PID.
The fixed dummy pipes have a 4 KiB capacity. `stdin_backpressure` creates its
descendant and readiness evidence but never reads its 24 KiB payload. The matrix
requires 4 KiB written and 20 KiB still pending when cancellation, control EOF,
lease expiry or the job deadline causes cleanup. Keepalives continue for the
deadline case, proving an absolute job deadline independently of lease expiry.

## Dummy budgets and production boundary

The matrix has a 90s sandbox preparation budget. The supervisor has a 5s start
deadline, 3s renewable lease, 10s job deadline, 250ms TERM grace and 3s cleanup
budget. Control input is limited to 32 KiB, child output to 1 MiB and the live
output queue to 64 KiB. These are explicit dummy limits; none replaces the
production 180s/200s CLI limits or its 5s kill-after setting.

A standalone typed TS adapter can use this protocol now: wait for ready, send a
single start, send keepalives, send cancel, demultiplex child data and validate a
single terminal. Normal success also requires child exit 0 and verified cleanup.
Missing or malformed acknowledgements remain unknown; a local wrapper close
alone is insufficient. The existing generic `Command(args,input,signal)` must
not silently translate arbitrary args into this fixed-DUMMY protocol.

Production integration still needs fixed trusted launch profiles, an explicitly
validated actual CLI filesystem/network/auth envelope, a suitable control-frame
budget, production deadline/lease choices and failure tests for that configuration.
Nonblocking child input is implemented and tested with the fixed dummy; its small
pipe and payload budgets do not establish the production CLI configuration.
No successful dummy run constitutes production authentication or inference validation.

Run the explicit offline matrix with:

```text
npx vitest run --config vitest.measure.mts evals/reality-compiler/subscription-wsl-wrapper.measure.ts
```

Each full run archives all fifteen cases (including cancellation before start
and failure immediately after child creation)
and SHA-256 identities of the Python, shell and
measurement sources under `scratch/subscription-wsl-supervisor/<uuid>/report.json`.

## Recorded offline validation, 9 September 2026

The fourteen-case matrix passed before the final setup-failure fixture was added:
`scratch/subscription-wsl-supervisor/7fc11fc3-bbdb-4733-afce-e6d7d71cafa5/report.json`.
Cancellation before start produced a closed, empty child-input channel and no
child PID. With a full child stdin pipe, cancellation and control EOF reached
local wrapper close after 299 ms and 300 ms respectively; lease expiry took
3,440 ms and the absolute deadline 9,815 ms, each measured from job readiness/action.
Every case had verified owned cleanup, no remaining namespace process and ESRCH
for all observed PIDs. These are individual dummy observations, not latency percentiles.

The final setup-failure addition then passed its separate focused run (1 passed,
14 skipped, `allCasesRun:false`):
`scratch/subscription-wsl-supervisor/e0d73a2c-5651-464d-8211-eec23add0bc9/report.json`.
It recorded 69 queued bytes, zero written bytes, closed input, supervisor error,
local exit 1 and verified disappearance of the direct child. Thus the evidence
is a fourteen-case run plus one additional fault run, not a single fifteen-case run.
