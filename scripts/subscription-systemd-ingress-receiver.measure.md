# Local receiver kernel primitives

This stdlib-only Linux harness imports the exact reviewed receiver SHA-256
`2d32b1508794f43cf5a6266f7ec666a42b2eacaabed60be4e20b471aa00e1f32`.
It invokes only `receive_fd` and `reserve_fd`; it never invokes receiver `run`,
path provisioning, systemd, unshare or exec. No actual run is claimed here.
The main agent dispatches it only after source review and an explicit handoff.

Five fixed scenarios use owned AF_UNIX socketpairs: one SCM_RIGHTS descriptor
with CLOEXEC and reservation at 198; refusal to overwrite occupied 198; two
rights rejected; wrong payload byte with a valid right rejected; and 32 rights
truncated by the receiver's fixed ancillary buffer. The last scenario records
the actual kernel MSG_CTRUNC flag. Malformed ancillary byte lengths cannot be
reliably emitted by a conforming kernel; the malformed scenario is explicitly
the authored payload, not a claimed malformed kernel control header.

Each receive retains the original five-second setup deadline. There is no
timeout-duration experiment or reduced deadline. Received and reserved identity
and CLOEXEC state are checked. Every owned descriptor/socket is closed, then
the process's metadata-only FD inventory must exactly match its starting
inventory and FD 198 must be absent. A preexisting 198 is never overwritten.
Any failure or unknown cleanup prevents the next scenario. The harness does
not repair unrelated descriptors or processes.

The unique scratch JSON preserves observations, failures, descriptor metadata,
cleanup and the exact two-file source hashes before/after. Source loading is
hash-bound. These synthetic local kernel experiments do not validate complete
receiver peer/path authentication, systemd resource admission, its fixed exec
handoff, credentials, external network access or production readiness.

Offline tests validate source admission, fixed scenarios, cleanup stop fencing,
preexisting FD protection and platform/argument rejection without running the
kernel scenarios. Runtime remains separately authorized.
