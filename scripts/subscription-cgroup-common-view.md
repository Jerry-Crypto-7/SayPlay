# Common visible cgroup2 view — metadata only

This helper samples only its own proc metadata and fixed directory metadata.
It does not launch a service, CLI, manager query, resolver, network connection,
workload, or credential operation. A separately reviewed trusted wrapper owns
service creation, source binding, pidfd/MainPID generation checks, output,
release protocol, and unit cleanup. This module's standalone entry refuses.

API:

- `sample_self(absolute_deadline)` returns one report after all local handles
  close successfully; `localHandlesClosed:true` concerns those handles only.
- `open_self_view(absolute_deadline)` returns a retained view with `sample()`
  and idempotent `close()`. Retained root/ancestor/membership directory handles
  remain owned by that view. A sample does not claim their closure.
- `validate_self_report(report)` is pure local replay.
- `held_identity(report)` returns actual parsed pid/startTicks/NSpid and
  pid/mount/cgroup namespaces plus membership, never a caller PID to operate on.
- `validate_common_view(observer_before, helper, observer_after,
  expected_binding)` is pure comparison. The exact expected binding is
  `{unit,uid,mainPid,mainStartTicks,controlGroup}` from the trusted launcher's
  own UUID, private-manager and retained-pidfd evidence. The validator does
  not authenticate that caller or infer pin ownership from a numeric PID.

The fixed deadline is at most five seconds from factory invocation, with at
most 32 samples in a retained view. A single serialized report is at most
512 KiB; an enclosing wrapper may safely refuse a report whose envelope would
exceed its own bound, but must not truncate it. Each proc snapshot has fixed
limits: cgroup 4 KiB, stat 4 KiB, status 16 KiB, mountinfo 64 KiB. Mountinfo
has at most 512 lines and 4 KiB per line. Raw bytes, byte count, SHA and regular
file identity are retained for before/after snapshots. Only `/proc/self/`
cgroup, stat, status, mountinfo and namespace symlinks are read. No foreign
manager proc path, root/fd/fdinfo/exe content, arbitrary PID, or caller path
is accepted.

Directory walks start at `/` and use O_DIRECTORY/O_NOFOLLOW/CLOEXEC for every
component. Targets are `/sys/fs/cgroup`, the four fixed current-UID ancestors,
and the leaf derived from actual self membership. Relative, empty, dot/dotdot,
escaped or control-character membership components are rejected. The sampler
requires exactly one cgroup2 mount at `/sys/fs/cgroup` and rejects every
subordinate mount overlay there. Before/after mountinfo bytes must match.
Every retained/reopened directory has matching device/inode/type and actual
fstatfs magic CGROUP2_SUPER_MAGIC; its device must match the selected mount's
major/minor. No chmod or path-string equality is substituted for this check.

The fixed comparison requires helper and observer to share the same PID
namespace and have one-level NSpid. It maps the helper's actual PID/startTicks
to the externally bound MainPID/generation, with exact own-unit ControlGroup.
All three samples share cgroup namespace and root/four-ancestor device/inode
identities. The observer stays outside the helper leaf and repeats its own
identity/view after the held helper observation. Mount namespace IDs need not
match; mount roots/devices and relevant directory identities do. Sample times
must follow before → helper → after order.

This establishes only the common **visible** hierarchy. Even a mount root `/`
does not attest an initial host namespace, manager namespace, invisible higher
ancestors, global capacity, exclusive OOM causality, or reserved headroom.
All three host/global/manager attestation flags remain false. Future actual
stress target ancestry and fresh capacity must be rebound separately; an old
sibling helper does not automatically prove a future leaf.

Every acquired descriptor is attempted during cleanup even after a close
failure; unknown close or deadline makes the module's failure fence sticky.
No unknown descriptor number is retried. The wrapper retains responsibility
for its own process/unit lifecycle and incomplete-output failure.

Tests use fake own-kernel metadata only, including overlays, ambiguous paths,
wrong filesystem/devices, namespace/generation mismatch, and close/deadline
failure. No actual metadata service or stress experiment has been run here.
