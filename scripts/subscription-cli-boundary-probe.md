# Fixed CLI descendant namespace boundary probe

This standalone experiment uses the same frozen runtime setup as the existing
credential-free capsule: pinned CLI/bwrap, copied read-only runtime, private tmpfs,
new user/mount/network/PID namespaces, pivot_root and detached host root. It does
not modify the frozen supervisor or runtime source files and does not constitute
a rerun of their transport/resource measurements.

Files: `subscription-cli-boundary-probe.sh`, parent `.py`, fixed `-child.py`, and
`.measure.py`. The shell accepts no arguments and is invoked only by the fixed
measurement command inside fresh namespaces. The parent executes actual pinned
`codex sandbox --permission-profile private-sentinel` with the copied child.
No prompt, login, auth/session file, credential store or inference is involved.

## Operations and limits

The child runs two separate owned fork descendants: combined user+mount unshare,
and user unshare followed by mount unshare. Successful user namespace creation is
followed only by writes to that descendant's own setgroups/uid_map/gid_map. Before
any mount mutation, it requires changed user and mount namespace IDs and no shared
or master mount propagation. Read-only proc/cgroup2 mount attempts and up to three
local proc detach attempts occur only in that proven private descendant namespace.
No host mount is mutated; no cgroup control receives a write.

Seven fixed paths test cgroup/root visibility using read-only open/fstat, never
file-body reads. Four fixed `/proc/1/fd` and proc-root descriptor paths are opened
nonblocking and only fstat'ed: **zero bytes are written**. Their device/inode/type
are compared against separately recorded outer control and output pipe identities.
Opening the nested CLI namespace's own pipe is distinguished from reaching the
outer pipe. There is no arbitrary caller path, PID, command or executable.

Each descendant has a 2s/32KiB response bound. The existing fixed runtime runner
has a 10s/128KiB child bound and owned namespace cleanup. An outer fixed 40s GNU
timeout (5s kill-after) and 47s Windows wait bound this synthetic experiment.
These are experiment budgets, not production 180s/200s job budgets or a claim that
this standalone experiment provides production cancel/resource enforcement.

## Actual final observations

Final raw:
`scratch/session7-cli-boundary-9fffbf2b-91d0-42ba-bde9-f8baf704247f.json`.
Before/after source hashes match. Actual child exit zero and empty owned namespace
were observed. The earlier successful attempt
`scratch/session7-cli-boundary-3295f722-2922-4b2a-8836-60873a83c8ee.json` is preserved;
it predates the additional outer namespace IDs/capability metadata.

| Operation | Both descendants actually observed |
| --- | --- |
| New user and mount namespaces | SUCCESS, distinct IDs |
| Own UID/GID map and setgroups setup | SUCCESS |
| Post-unshare capabilities | CapEff and CapBnd `000001ffffffffff`; NoNewPrivs `1` |
| Read-only proc mount | EPERM (`1`) |
| Read-only cgroup2 mount | EPERM (`1`) |
| Local `/proc` detach | EINVAL (`22`), no layer removed |
| Cgroup paths and oldroot | ENOENT, or EACCES through proc-root links |
| Four proc descriptor opens after unshare | EACCES (`13`) |
| Cgroup/descriptor bytes written | `0` |

Before unshare the nested namespace's own stdin/null device and stdout pipe can
be opened. Their identities differ from the outer protected pipes. After unshare,
all four fixed proc descriptor paths return EACCES. The mount inventory records
two proc entries at `/proc`; their detach returned EINVAL. **EINVAL is not reported
as permission denial**, and no claim is made that all possible mount operations or
proc-reference paths have been exhausted.

The experiment explicitly disproves a stronger possible assumption: zero effective
and bounding capabilities at CLI entry **do not mean every descendant keeps zero
capabilities**. Here both newly created user namespaces report full namespace-local
capability masks. These observations do not claim those capabilities are effective
in the host user namespace. New namespace creation itself is not blocked.

## Evidence interpretation

`boundedExperimentPassed` checks completeness of these exact operations and that
none of the tested paths exposes cgroup controls, detached host root or the outer
protected descriptor identity. It is a trusted local evidence validator, not
cryptographic provenance, an arbitrary hostile-code test or hostile-proof
attestation. Only two fixed namespace strategies, seven paths and four descriptor
paths were tested. Successful namespace creation and every failure errno remain
in the raw record; they are not collapsed into a blanket sandbox PASS.

`python -B scripts/__tests__/subscription-cli-boundary-probe.test.py`: **16/16 PASS**,
including changed control identity, exposed descriptor/cgroup, missing observations
and incomplete successful namespace setup. Production readiness remains false;
production auth, network and cleanup are `NOT_RUN`. This experiment does not
validate an authenticated resource-constrained production dispatcher.


## Validator revision 2: strict completeness remediation

Independent review identified two false-positive evidence paths in revision 1:
a claimed successful unshare plus placeholder `afterNamespaces` could omit all
subsequent snapshots/operations, and sequential mount-unshare failure EINVAL could
be accepted as a denial. These were validator defects; the retained actual final
raw record already contains the complete successful experiments.

Revision 2 validates exact operation order, all three own namespace map operations,
changed well-formed user/mount namespace identities, unchanged PID namespace,
explicit private descendant guard, post-unshare status/proc inventory, both mount
attempts, every proc-layer attempt and every required boundary snapshot. Missing,
reordered, unknown or contradictory fields fail closed. Denied unshare branches
must match the exact early-return shape and errno EPERM or EACCES; EINVAL cannot
supply unshare/mount permission-denial credit. A detach returning EINVAL is still
recorded as an unsuccessful operation and requires its complete subsequent
boundary snapshot. It is not reinterpreted as permission denial.

The final raw artifact above passed **offline revalidation with revision 2**.
The child, launcher and frozen supervisor/runtime sources were not changed for
this remediation. No new CLI execution is claimed. The new
`scratch/session7-cli-boundary-summary-v2.json` binds the raw artifact SHA-256,
current validator/test hashes, prior summary hash and unchanged executed-child
identity. The previous raw records and summary remain unchanged. The 16-test
suite includes both review reproductions plus missing operation/snapshot, unchanged
namespace IDs, missing private guard and mismatched proc-layer regressions.
