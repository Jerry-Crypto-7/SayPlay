# Trusted control boundary probe — not integrated

This authored, credential-free probe has no runtime integration yet. It is
intended to execute after the existing worker trampoline has established a
private PID/mount/proc view and installed lockdown. It does not install a filter,
create a namespace, launch a process, read credentials or inspect arbitrary PIDs.
No actual boundary credit follows from its offline tests or standalone report.

The integration owner must first capture metadata from its own live, pinned
control pipes and authored objects, then expose exactly
`/work/trusted-control-boundary.json` as a readonly regular-file mount to the
worker. The existing sandbox/trampoline does not expose that marker or invoke
this probe. A missing, mutable, symlinked, oversized or malformed marker fails
before protected-path probes. Merely chmod 0444 is insufficient: the reader
requires a readonly mount via fstatvfs. It opens `/work` without symlink following,
then opens the fixed basename relative to that descriptor with O_NOFOLLOW and
O_NONBLOCK, rejecting FIFO and non-regular targets before reading.

The CAPS0 trusted parent can create the fixed file in its already writable
`/work` only after its actual pipes exist. It does not mount anything. The
existing managed sandbox entry structure can add this one path with `access:read`
alongside the writable `/work/exec-worker`; the executor's existing sandbox
builder must perform the exact readonly file bind. A mount of the whole `/work`
directory would expose trusted homes and is not this contract. Actual fstatvfs
admission verifies the resulting file mount, so a configuration-only assertion
does not grant readonly evidence. This uses no new parent capabilities or
mount broker; the exact file entry and new fixed probe dispatch remain explicit
future integration changes under separate ownership.

The marker has exactly four fields:

- `version:1`.
- `namespaces:{trustedPid, trustedMount}`, Linux namespace inode strings.
- `protectedDescriptors:{outerSupervisorControl, outerSupervisorOutput,
  appServerControl, appServerOutput}`. Each value has only dev/ino/type, with
  FIFO type required. All four tuples must differ; that is an intentional
  constraint on the first fixed integration, not a universal process property.
- `authoredProtectedObjects:{appServerHome, appServerSentinel}`. The directory
  and regular-file tuples establish their observed pre-dispatch existence on
  the trusted side. They contain no body, path override, PID, FD number, token,
  argv or environment values.

The fixed paths are `/work/environment-appserver-home`, its `/sentinel`, their
two `/proc/1/root` variants, and `/proc/1/fd/0`, `/proc/1/fd/1`, `/proc/1/fd/2`.
Every target is opened O_RDONLY/nonblocking and immediately closed, with zero
body reads and zero writes even if the open unexpectedly succeeds. Any success
on a protected HOME/sentinel path fails validation. EACCES/EPERM is recorded as
`denied`; ENOENT is recorded as `absent`, never relabeled permission denial.
Absence can show the known authored object is not visible at the fixed worker
path only when external pre-dispatch object binding is supplied.

An open on a fixed `/proc/1/fd` path is not automatically an escape or a denial.
It is allowed only with a fresh proc view: worker self PID namespace equals
the observed PID1 namespace and differs from the trusted namespace; mount
namespace also differs. Every successfully opened proc descriptor and each
standard worker FD 0/1/2 must differ from **all four** protected pipe identities.
No FD>2 may remain in the worker report. The new app-server roles are separate
from the historical outer-supervisor pair; comparing only the latter would miss
the intended additional boundary.

`validate_report(report, expected_marker)` requires separately supplied trusted
metadata. It verifies the exact marker bytes/hash, schema and expected values,
complete fixed-path observations, NoNewPrivs1/Seccomp2/nonzero filter count,
zero effective/bounding capabilities, fixed cwd and four environment names.
The probe never invokes this validator against its own marker as an authority
and never emits a PASS field. The outer measurement must bind expected marker
values and file hash to the actual owned pipe/object observations before worker
dispatch, then verify source/image identity and owned cleanup separately.

The marker is a trusted-caller evidence contract, not cryptographic origin
attestation. Readonly mounting prevents worker mutation in the intended profile;
it does not prove who created a supplied marker. No host auth store or actual
credential is needed: the protected auth-like object is an authored sentinel.
This is a bounded fixed-path/descriptor test, not a general hostile-descendant,
authentication, network, resource-exhaustion or production-readiness guarantee.

Future integration ownership is explicit: the trusted parent/gate owner creates
and binds the marker after its pipes exist; the sandbox owner exposes exactly
this readonly marker and fixed probe entry; the measurement owner supplies the
external marker and verifies cleanup. These hooks are not added by this change.
