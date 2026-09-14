# Credential-free resource envelope discovery

`subscription-resource-envelope.py` accepts no arguments. On Linux it reads
only `/proc/self/mountinfo`, `/proc/self/cgroup` and the fixed
`/sys/fs/cgroup/codex-subscription` metadata. It does not create that directory,
enable controllers, move or kill processes, read credentials, or execute Codex.
Run with isolated Python and bytecode disabled:

```text
wsl.exe --distribution Ubuntu-24.04 --exec /usr/bin/python3 -I -B /mnt/d/claude/Hackaton/scripts/subscription-resource-envelope.py
python -B scripts/__tests__/subscription-resource-envelope.test.py
```

The fixed directory is a proposed deployment location, not an existing or
validated production dispatcher. A missing subtree is a prerequisite failure.
Do not change permissions, install a privileged helper, or silently select an
unrelated user/session cgroup to make discovery pass.

## What the result means

Discovery PASS requires one full cgroup2 mount at `/sys/fs/cgroup`, writable
mount metadata, an empty domain parent, available **and enabled** memory/pids
controllers, and effective-access hints for the directory, `cgroup.procs` and
`cgroup.subtree_control`. Missing/unknown/malformed/oversized data fails closed.
Open operations walk fixed components with directory FDs and `O_NOFOLLOW`;
metadata file descriptors must be regular files on cgroup2 (`fstatfs`). Each
file is limited to 64 KiB and 512 lines. Mount/membership metadata is checked
again after the read. Access checks are hints, not a write/delegation test.
Metadata reads are not an atomic snapshot or hostile-kernel attestation.

Every report keeps `productionReady:false`, `enforcementStatus:NOT_RUN` and
`delegationStatus:NOT_VERIFIED`, even when discovery passes. A pure validator
accepting caller-supplied text does not establish that text's origin. A
configured parent `memory.max`/`pids.max` is metadata, not per-job enforcement.
`max` is represented as null (unlimited), not zero or an invented budget.

The existing 180000 ms job deadline, 200000 ms command deadline, 5000 ms kill
grace, 8 MiB output cap, gpt-5.6-sol/low and subscription-only transport are
unchanged. This module does not choose a new production RAM/PID budget.

## Remaining enforcement work

1. A trusted host service must actually delegate an isolated cgroup v2 subtree
   with memory and pids enabled. Keep the dispatcher/control process outside
   each job leaf, and do not expose writable parent/ancestor cgroup FDs or
   mount paths to the job. Checking access mode bits alone is insufficient.
2. Before executing a job, create its exclusive leaf, set and read back an
   explicit `memory.max`, `memory.swap.max`, `pids.max` and OOM policy. Establish
   membership **before** executing untrusted code or allocating its workload.
   Forks/threads and detached descendants must inherit the same bounded leaf.
   The dispatcher must not share the leaf with unrelated processes.
3. With a fixed credential-free workload, observe actual aggregate allocation
   pressure/OOM and bounded fork/thread creation, event counters and matching
   job identity. Include normal, cancel, deadline, output/input backpressure,
   partial setup and detached-descendant cases. Verify escape/migration denial,
   empty `cgroup.events populated`, owned reaping and removal of only that leaf.
   The service needs a crash/disconnect cleanup mechanism independent of its
   client pipe; an inventory tool cannot prove it.
4. Revalidate this exact production configuration and budgets with the real
   CLI before any auth/network validation. The synthetic runtime PASS does not
   authorize reading host credentials or arbitrary credential operations.

`RLIMIT_AS` is a per-process virtual-address limit; it is not aggregate resident
memory control. `RLIMIT_NPROC` is associated with the real user ID, so it is not
an exclusive per-job process/thread envelope. tmpfs capacity limits filesystem
storage and is not a process RAM budget. A PID namespace provides visibility
and cleanup isolation but is not a process-count limit. All are distinct from
cgroup v2 hierarchical memory and PID accounting/enforcement. Even memory.max
does not constitute a general host resource/latency guarantee.

Sources: [kernel cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
for delegation, inherited membership, no-internal-process constraints and
memory/PID controls; [getrlimit(2)](https://man7.org/linux/man-pages/man2/getrlimit.2.html)
for per-process address-space and real-UID process limits.

## Session 7 evidence

Initial read-only WSL launch was blocked by `Wsl/Service/E_ACCESSDENIED` in the
default sandbox. The same fixed command under narrow standard escalation ran
and returned FAIL because the fixed delegated subtree was absent. No cgroup
mutation, credential operation, CLI execution, inference or network probe was
performed. Reports and source/test hashes are retained under
`scratch/session7-resources*`; this is an infrastructure prerequisite finding,
not a failed inference or completed production resource validation.
