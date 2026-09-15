# Stock-client capture runner

The new fixed profile consists of `subscription-tool-capture.measure.py` (Linux
host driver), `subscription-tool-capture-capsule.sh` (isolated image builder),
`subscription-tool-capture-runner.py` (PID1 parent), the HTTP adapter and the
authored harness/capture peer. Existing production gates and metadata profiles
are not changed.

The driver creates one UUID systemd user unit with requested MemoryMax=2G,
MemorySwapMax=0, TasksMax=64 and RuntimeMaxSec=180. It uses a fresh mapped user,
mount, PID, network and UTS namespace. The capsule copies only fixed runtime
files and helpers into tmpfs, makes runtime roots read-only, pivots root and
detaches the host root. It exposes only loopback; the installed stock CLI/bwrap
hashes must match the existing pinned identities before the client starts.
No worker executable or production executor gate is installed in this image.

The parent creates an exclusive fresh Codex home and a fixed environment pointing
to its capture-only entrypoint. It launches stock appserver with an explicit
environment, no inherited credentials, dropped capabilities and no-new-privs.
It serves only the namespace-local `127.0.0.1:31317` Responses peer. The 25-second
parent deadline covers nonblocking HTTP and appserver IO; the enclosing unit and
host driver bound setup and abnormal termination separately.

## Actual result — 11 September 2026

The source-bound experiment passed in
`scratch/continuation-tool-capture-actual-5919e8bd972c41b49290f0b82bcd9eab.json`.
The 162490-byte terminal stdout records a stock-client start request, deliberate
RPC refusal, two delivered authored model responses, completed appserver turn,
three observed pidfds reaching ESRCH, an empty namespace and full pipe EOF.
The host confirmed its own unit absent and unchanged source hashes. Parent time
was 756 ms; host time was 7487 ms.

Independent offline replay passed 56 checks in
`scratch/continuation-tool-capture-independent-replay.json`: archive lengths and
hashes, current/before/after/runtime source agreement, binary hashes and complete
capture event replay. Cleanup was checked as archived evidence, not re-observed
in a new kernel experiment.

The adjacent `.request.json` preserves exactly 1047 received bytes, SHA-256
`6e15f67afd9c7d2441bb992e566fa8d8a2b4787d0a3a3e8c258d0861b8c9d062`.
It has RPC id9 after cwd and three ancestor git metadata requests, a dynamic
integer/UUID process handle, shell argv, nonempty env and inherit-all envPolicy.
The read-only sandbox omits the production control profile's extra path entries.
Consequently this is **capture success only**; production gate compatibility
and successful worker execution are still unresolved.

Five earlier failed experiments are preserved, in order:
`78bf7fb42fac4377bf1a556904dddff8`, `d8def646df2545e3b263b354fa85e4a9`,
`50f9751d696543f79dd40120addc1dea`, `57265f5ca7b8462686201175284c62aa`,
`05360051b9064fcc90219c3a4165e971`. They exposed the Responses Lite carrier and
previously unhandled cwd/git discovery. All kept clean namespace/unit cleanup.
The second and fourth runs added missing failure diagnostics instead of changing
admission blindly. The endpoint now describes the finite synthetic tree; the
stock client can pipeline the three ancestor marker stats, as confirmed by
upstream file-system/find_up.rs. No general filesystem access was added.

Final scoped validations: 40 endpoint/runner tests, 71 harness/HTTP tests and 11
driver tests passed in their respective latest XML artifacts documented in
PROJECT-STATUS.md. The initial driver cleanup-test failure on Windows lacked a
mocked Linux SIGKILL constant; the failing artifact remains preserved.

HTTP has a bounded header/body parser, no chunking, compression or pipelining,
and at most two connections/responses. The parent accounts for actual partial
writes. The model catalog uses Responses Lite, so the actual stock request moves
tool definitions into a developer `additional_tools` input item. This was
observed and corroborated by pinned `core/src/client.rs:842–863` and its
responses_lite integration test; see
`scratch/continuation-missing-tools-source/receipt.json` and `findings.md`.

The capture entrypoint writes one exclusive `/work/capture-evidence.json`,
separate from appserver stderr. Its bootstrap/filesystem replies are authored
fixture data. It describes fixed directories `/work/exec-worker`, `/work`, `/`
and absent `.git` markers at those levels, each queried at most once after the
initial two skill-directory stats. This is not host filesystem inspection.
The first `process/start` is recorded byte for byte and deliberately refused.

On exit the PID1 parent kills/reaps only its exclusive namespace descendants,
checks observed pidfds for ESRCH, drains pipes nonblockingly, and closes its
handles. Live and final stdout use the same strict parser: a partial or unexpected
post-completion frame cannot silently pass. After namespace cleanup it reads a
bounded regular evidence file, checks identity/size/timestamps and replays the
capture conversation. Failed endpoint documents remain diagnostic, never PASS.

The host driver binds before/after source hashes to the terminal source map,
checks fixed binary hashes and component completion, and confirms its own unit
is absent. Exact stdout/stderr bytes and hashes are archived under unique
`scratch/continuation-tool-capture-actual-*.{json,stdout.bin,stderr.bin}` paths.
These are experimental source-bound observations, not hostile-client-proof
attestation. Resource limits are requested, but cgroup readback is explicitly
unattested. Neither model inference nor successful worker execution is claimed.

Scoped review found and regression tests fixed inconsistent post-completion
parsing, blocking drain after partial setup, cleanup exceptions skipping handle
closure, and driver cleanup exceptions skipping failure receipts. The host
loop budget is 190 seconds, leaving cleanup/archive time inside its 230-second
outer timeout. The driver only stops its own UUID unit and own process group.
