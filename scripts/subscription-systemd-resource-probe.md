# Systemd user-manager resource discovery and fixed synthetic probe

The absence of the proposed `/sys/fs/cgroup/codex-subscription` directory does
not establish that resource enforcement is unavailable. This separate probe
discovered the existing WSL Ubuntu-24.04 systemd user manager and tested a
unique, temporary unit without installing a service or changing system config.

Default mode is read-only. It reads only fixed process/cgroup metadata, stats
the current user's bus socket, and requests a fixed set of manager/app.slice
properties through `systemctl --user show`. It never dumps environment values,
reads credential/session files or queries login/auth state.

```text
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-systemd-resource-probe.py
```

Explicit `--run` launches one own unique `codex-resource-probe-<uuid>.service`
with MemoryMax=64M, MemorySwapMax=0, TasksMax=16, RuntimeMaxSec=15,
TimeoutStopSec=2, KillMode=control-group, NoNewPrivileges=yes and
OOMPolicy=continue. These are **synthetic fixture limits**, not production
constants. It uses `systemd-run --user --no-ask-password --wait --pipe --collect`
and `/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -I -B` for the fixed
worker in this file. No sudo, polkit prompt, persistence, CLI, auth or network
operation is requested. Each attempt's unit/configuration is archived before
dispatch under `scratch/session7-systemd-attempt-*`.

The worker verifies its own exact leaf path and reads back the three limits.
It attempts at most 32 forks, reaps its sleeping children after two seconds,
then starts one child that attempts at most 128 MiB of touched allocation.
A 12-second worker alarm and systemd's separate runtime/stop limits bound the
fixture. The worker and its children share the capped leaf; systemd is the
guardian outside that leaf. There is no reserved worker RAM guarantee.

It records actual fork errno, task counts and pids.events, child signal and
memory.events. Final cleanup requires own-unit LoadState=not-found and absence
of that exact leaf. Unknown cleanup cannot pass. On wrapper timeout it requests
stop for only the invocation's own UUID unit. Normal leaf removal is verified;
the full cancel/disconnect/fault matrix is not covered by this fixture.

The safe boundary observation opens own `memory.max` and parent
`cgroup.procs` O_WRONLY and immediately closes, writing **zero bytes**. It never
migrates a PID or changes any limit. Permission-denied observations are separate
from resource enforcement; even both denials would not establish hostile
namespace escape resistance. The default transient unit does not supply the
filesystem/control/auth isolation required by a production capsule.

## Actual session 7 observations

- Read-only discovery: system PID1 `systemd`, user 1000 manager version
  `255.4-1ubuntu8.17`, manager running, app.slice memory/tasks accounting enabled,
  and root memory/pids controllers available/enabled.
- First unit `3cd35d8eb36e48268a89803714e6eea0`: exact 64 MiB/0 swap/16 tasks
  readback; 15 children plus worker, next fork EAGAIN, pids.events max 0 to 1;
  memory child SIGKILL with oom_kill 0 to 1; worker exit 0, unit collected and
  leaf absent. Pre-dispatch record retained. This first run predates automatic
  full-result archival and boundary observations; its observed facts are in
  `scratch/session7-systemd-summary.json`.
- Second unit `58251ea3b8ef45b9b92278b1a52e90b9`: same resource checks PASS and
  unit/leaf removal verified. **Both write-open operations were allowed**;
  `cgroupWriteOpenDenial:FAIL`, zero bytes written, no migration performed.
  Full raw stdout, configuration, discovery and evaluation are retained in
  `scratch/session7-systemd-result-codex-resource-probe-58251ea3b8ef45b9b92278b1a52e90b9.service.json`.

All results remain `productionReady:false` and
`hostileEscapeResistance:NOT_VALIDATED`. The fixture proves kernel enforcement
for cooperating bounded synthetic children, not resistance to a hostile child
that can reach writable cgroups or its user manager. Production needs a capsule
that denies those paths/descriptors and bus access, followed by real validation
of that exact integration. No production subscription settings are changed.

Sources: [systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html),
[systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html),
[kernel cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
