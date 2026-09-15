# Credential-free CLI runtime probe — 10 September 2026

This probe executes the installed Linux CLI, but **does not validate production
authentication, network access, inference or production cleanup**. The production
subscription bridge remains separate and has not been migrated to the dummy
supervisor. No login command is part of this probe.

The executable inventory only resolves metadata in named installation locations.
It found `~/.local/bin/codex`, resolving to the standalone Linux musl
0.145.0 package. A clean `/usr/local/bin:/usr/bin:/bin` PATH had no CLI, while the
inherited WSL PATH selected a Windows npm wrapper. A PATH lookup is consequently
not an acceptable production executable identity.

## Fixed capsule

`subscription-runtime-probe.sh` takes no arguments. It copies only the exact
0.145.0 CLI and bundled bwrap, system Python/setpriv and their runtime libraries.
It does not copy user configuration, authentication or session files. Its private
tmpfs runtime has a 768 MiB capacity; writable scratch has a separate 64 MiB
capacity. These are probe filesystem capacities, not process memory limits, and
do not change the production 180s/200s/5s/8MiB limits.

The launch uses user, mount, network and PID namespaces. PID1 pivots to the new
root, detaches the old root, closes inherited descriptors above stderr and
reexecutes the copied Python. It verifies the mount inventory, absent host paths,
read-only `/usr`, exclusive PID namespace and loopback-only network. Children
receive an empty explicit environment, a new temporary HOME/CODEX_HOME, zero
effective/bounding capabilities and NoNewPrivs. The parent is nondumpable.

The final launcher uses `--map-current-user --keep-caps`: namespace capabilities
survive exec only for the trusted setup, while setpriv removes all capabilities
from the CLI child. Mapping UID 0 is unnecessary. Standard null/zero/full/random/
urandom devices are available; `/dev/tty` is explicitly bound to `/dev/null`, not
to a host terminal. The CLI and bundled bwrap SHA-256 are pinned and checked
before either executes. No environment override can select another binary.

Operations are fixed: version/help, exec help, sandbox help, a direct synthetic
Python check and that same synthetic check through `codex sandbox` with read-only
configuration. Each has a 10s deadline and 128 KiB output limit; owned cleanup is
bounded to 3s with repeated kill/reap. No user-provided argv, prompt or executable
is accepted. The synthetic network check targets TEST-NET inside a namespace
without an external interface. It is not a production egress-policy test.

The parent evaluates the actual child facts. Exit zero alone cannot establish a
PASS. ENOENT on a descriptor is not counted as permission denial. Descriptor
checks never truncate or write to the parent stream. The probe's namespace
cleanup is not credited as production timeout/cancel validation.

## Actual results and retained failures

`scratch/session6-runtime-summary-v2.json` references the final attempts and
current probe source hashes. `scratch/session6-runtime-probe-pinned.json` contains
the final raw report (PowerShell redirected UTF-16 JSON). The earlier summary
and the artifact named `session6-runtime-probe-final.json` are retained interim
UID-map failures, superseded by later explicitly named attempts.

- CLI version/help operations: **4/4 PASS**, exact CLI SHA-256
  `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`.
- Direct synthetic checks: caps/NNP, runtime write denial, permitted scratch
  write, network unreachable and parent descriptor denial all PASS.
- Actual CLI sandbox: **PASS for this fixed credential-free synthetic probe**.
  Writes to `/work` and `/usr` are denied, network connect returns EPERM,
  capabilities remain zero and NoNewPrivs is set. The owned namespace was empty
  after each operation. No auth or inference was attempted.
- Direct child cannot open the outer PID1 output (EACCES). Nested CLI child can
  open its own PID1 output pipe, which is proven distinct from the protected
  outer pipe using namespace IDs plus descriptor device/inode/type. No inherited
  descriptor matches the protected output. This is recorded as isolation, not a
  fictitious permission denial. Two stacked `/proc` mounts are retained as facts;
  they share one visible path. In its different, private mount namespace the
  synthetic child cannot unmount `/proc` (EPERM). This does **not** prove a hostile
  descendant cannot create another user/mount namespace and uncover a lower layer.
- Offline evidence-validator tests: **7/7 PASS**, including false capabilities,
  missing metadata, exposed descriptor identities, unrelated OS errors and
  changed runtime hashes.

Earlier attempts remain separate: insufficient 320 MiB runtime copy; help-only
success; missing bundled bwrap; chroot/new-user-namespace failure; pivot-root UID
map failure; map-current-user mount setup failure; missing capsule devices;
incomplete nested descriptor observations. The third driver returned zero
for the help-only subset despite its embedded CLI sandbox failure; later drivers
include sandbox facts in their overall result. None of these is production PASS.

The root change addresses the documented incompatibility of creating a user
namespace from chroot; it does not modify sysctls or relax sandbox policy.
See [unshare(2)](https://man7.org/linux/man-pages/man2/unshare.2.html) and
[pivot_root(2)](https://man7.org/linux/man-pages/man2/pivot_root.2.html).
The UID-map failure was resolved with the documented current-user mapping and
setup capability retention, without changing sysctls or retaining child
capabilities. Production auth/network and hostile descendant behavior remain
separate work. Do not mount host HOME, expose a terminal or bypass the CLI sandbox.

`subscription-production-profile.ts` records runtime, production filesystem,
ChatGPT auth, production network and production cleanup as separate required
stages. It is a trusted-caller contract, not cryptographic attestation. The source
review and ordinary provider seams reject incomplete or mismatched production
evidence. This probe cannot unlock them on its own.

### Private-path follow-up (10 September, profile v2)

`scratch/session6-runtime-private-v2.json` passed all fixed checks, including a
named permissions profile loaded by the actual CLI from a newly created synthetic
`/private/config.toml`. The sandboxed command could not read `/private/sentinel`
or its `/work/private-alias` symlink (EACCES), while it read a public control file.
Direct controls before and after, and the ordinary read-only sandbox baseline,
could read the synthetic private sentinel. No host config, auth or session files
were mounted or read. The report remains `productionReady:false`, with production
auth/network/cleanup NOT_RUN. This extends the pinned synthetic probe; it does not
validate an authenticated transport. Python validator tests: **8/8 PASS**.
Source and raw report hashes: `scratch/session6-runtime-private-summary.json`.
The first private-profile attempt remains `scratch/session6-runtime-private-first.json`.
Profile syntax follows [official permissions documentation](https://learn.chatgpt.com/docs/permissions).

Next engineering work is a reviewed fixed production dispatcher with real resource
limits and protected control/auth boundaries, followed by actual production
network and cleanup validation. The synthetic capsule is not that dispatcher.
