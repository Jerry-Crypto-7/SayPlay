# Fixed HTTP ingress capsule measurement

The subsequent actual basic run `703df657-1b48-4e99-b249-b0374c355b04`
passed against 30 archived sources, with independent replay. The worker's
socket constructor was denied with EPERM before connect (zero connect calls,
no socket created); both trusted listener observations and the subsequent
authored HTTP exchange/EOF completed. All 53,442 child bytes were retained and
hashed; ten pinned processes reached ESRCH and the namespace was empty, with
separate broker/thread/peer cleanup. See
`scratch/session8-http-capsule-stage-actual-summary.json` and
`scratch/session8-http-capsule-stage-actual-replay.json`.

Earlier actuals `5e04cad0` and `388c3a08` remain FAIL: first client setup,
then an insufficiently specific worker error report. The latter cannot be
retroactively classified as a constructor denial. This successful run still
uses an authored trusted client, not a stock CLI-issued proxy handshake.

The initial implementation introduced the following measurement. The new
fixed Windows entry uses the HTTP launcher, preserving its original ownership,
ready, output and terminal JSONL. It archives raw child output separately from
parsed evidence. The original capture/owned-process cleanup driver is loaded in a
private module; no old wire frame or successful child response is manufactured.

Thirty source files bind before/after/current content. Nineteen of those bind the
actual outer launcher's source map. Before START the driver requires both the
original ten-helper boundary and the new fourteen-helper HTTP boundary, pinned
CLI and bwrap hashes, unchanged 180000/200000/5000/8388608 limits, loopback-only
capsule sandbox metadata, distinct typed outer FIFO identities, namespaces and
the actual FD198 ownership socket/nonce. START has only the fixed HTTP mode,
fourteen current hashes and that observed nonce.

Success requires the new HTTP child's full replay against the actual outer
worker and ingress identities. It also requires ordered ownership→ready→started
→child output→capsule terminal→launcher terminal; pinned capsule PID cleanup and
launcher broker EOF, exact 67-byte CONNECT plus 79 challenge bytes, 39-byte
response plus 87 ACK bytes, known launcher wait and closed threads/peers. The
97→67-byte HTTP normalization belongs to the child adapter accounting; it must
not alter the independent outer broker counters. Launcher cleanup does not
attest remote process cleanup; the capsule terminal supplies its own evidence.

This profile is basic, credential-free and authored. No systemd resource,
authenticated provider, actual CLI proxy traffic or model-inference credit is
granted. Runtime requires a separate frozen source review and explicit handoff.

After the preserved first actual `FIXED_CLIENT_CONNECT_FAILED`, the new HTTP-only
bootstrap receipt `trustedHttpLoopback` is mandatory before START: exact `lo`,
positive net/user namespace identities, typed 16-bit before/after flags with
LOOPBACK present before and LOOPBACK|UP after. RUNNING may be present; no exact
8-to-9 transition is assumed. Full child replay additionally binds the marker's
HTTP network namespace to this actual ready namespace. The receipt describes
supervisor-observed bootstrap configuration, not authenticated traffic. Previous
FAIL artifacts and source archives remain unchanged; the source inventory and
all timing/output budgets stay the same.
