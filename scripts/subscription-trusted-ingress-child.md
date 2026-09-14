# Fixed trusted ingress FD child

Separate basic-only capability experiment; no actual run in this implementation
step. No auth, provider connection, real CLI proxy routing or systemd FD credit.
The fixed Linux/no-argument child sets fd198 CLOEXEC immediately, before helper
loads or spawns. It verifies actual S_IFSOCK/dev/inode, connected AF_UNIX /
SOCK_STREAM, non-listening status and noninheritability. Socketpair SO_PEERCRED
is not treated as current-process authentication. No SCM_RIGHTS or caller FD.

The actual startup stdin packet retains all five fields: version, sourceOfOuter,
namespaces, protectedDescriptors, and ingress. The first four use the reviewed
parent contract; ingress is exactly `{fd:198,nonce:<32 lowercase hex>,socket:
{dev,ino,type:49152,family:1,socketType:1}}`. Bounded raw bytes and EOF are preserved;
no derived four-field JSON is represented as received data. Outer ownership and
ready must independently bind nonce/socket and protected pipes. PID1 must close
its copy after handing fd198 only to this child.

Private source-bound adapters reuse the old parent without editing it. The new
ten-helper map adds child/new probe to the previous eight. Existing app-server /
gate subprocesses retain close_fds=True and no pass_fds. Descriptor198 is not in
their environment or argv. The new marker has a separate socket role; the old
four-FIFO marker is unchanged. Worker descriptor observations are distinct from
source evidence that app-server/gate do not inherit the socket.

After actual initialize-only app-server startup, before the separate worker, the
child sends the fixed CONNECT header for fixture.invalid:443 to the owned local
broker, checks its fixed response, and exchanges BEFORE nonce / ACK BEFORE nonce.
After the actual worker, with the app-server still alive, AFTER / ACK AFTER is
followed by shutdown(SHUT_WR), actual EOF without trailing bytes and socket close.
Closure occurs before the app-server cleanup wait. This is one CONNECT and two
authored challenges, not real provider routing or DNS/TCP work.

The broker's five seconds begin at CONNECT and are not extended. Every IO checks
the original 22-second work and 30-second shared total; the parent128KiB capture
cap is unchanged. Partial actual send/receive bytes and hashes are retained;
unexpected trailing EOF bytes are recorded. Socket EOF/close does not attest
outer broker threads, capsule descendants or namespace cleanup.

`validate_report(report, dependencies, expected_worker_boundary, expected_ingress)`
takes source-bound parent, gate, policy, new probe and fresh old-probe loader as
the five dependency entries. Actual ready.workerBoundary and independently bound
{fd,nonce,socket} are mandatory. Internal validation establishes consistency only.
It checks actual raw five-field packet, separate socket marker, full parent /
worker replay and BEFORE/AFTER ordering. No production readiness is assigned.

Review corrected stale post-AFTER admission with a fresh22s check, while retaining
the original actual object sample time. AFTER's route timestamp follows EOF/close.
Final elapsed is refreshed after source hashing and after validation, rejecting
shared30s overflow. Tests explicitly delay AFTER and final hash/validation.

Initial21PASS/7FAIL came from Windows Python missing AF_UNIX in the pure validator;
the Linux wire constant is now explicit, while runtime uses Linux APIs. Initial
joint186PASS/8ERROR was a standard pytest temporary-directory ACL admission
failure. Both remain archived. Narrowly approved offline rerun (no WSL, network,
credentials or ACL changes) passed205 tests in
scratch/session8-trusted-ingress-joint-unit-v2.xml. No runtime was attempted.
