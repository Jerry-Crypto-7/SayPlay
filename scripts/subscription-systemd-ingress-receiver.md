# Fixed systemd ingress receiver

This new Linux-only receiver is not enabled by any existing launcher. The exact
CLI is `--handoff UUID NONCE CONTROLLER_PID CONTROLLER_START_TICKS SOCKET_DEV
SOCKET_INO` (six values, no version tail). UUID/nonce are32 lowercase hex; numeric
fields are bounded canonical decimal, PID2..2147483647, positive ticks/inode.
There is no caller path, fd number, environment, executable or callback argument.

It derives `/run/user/<ownuid>/rc-ingress-<UUID>/handoff.sock`. All path components
are lstat-checked directories/socket rather than symlinks; runtime/user-owned
components match ownUID, the fresh UUID directory is0700, socket0600, and its
exact dev/inode matches invocation metadata. Before/after connection and transfer
identity must remain unchanged. The controller must create and own this private
rendezvous as part of its own UUID experiment; receiver does not create/remove it.

Wire contract for the future companion:

- Receiver sends newline JSON `{version:1,type:'receiver_hello',uuid,nonce,pid,
  startTicks}` after private path and controller peer admission.
- Controller sends exactly `{version:1,type:'fd_offer',uuid,nonce,socket:{dev,ino,
  type:49152,family:1,socketType:1}}` as newline JSON, max1024bytes. Duplicate keys
  and extra fields fail. Receiver reads one byte at a time through the newline,
  leaving the subsequent ancillary record untouched.
- Controller sends precisely byte F with one SCM_RIGHTS fd, once. Receiver uses
  recvmsg MSG_CMSG_CLOEXEC|MSG_DONTWAIT and a bounded ancillary buffer. Wrong F,
  truncation, excess/foreign ancillary records or misaligned fd payload reject;
  every actually received fd is closed on rejection, even when another close
  fails. No retry/second transfer is admitted.
- After socket identity/kind/connectivity and no-overwrite fd198 reservation,
  receiver sends `{version:1,type:'fd_received',uuid,nonce,fd:198,socket}`. This is
  a received-capability ACK, not evidence of exec, worker safety or cleanup.

SO_PEERCRED must match the exact controller PID and current UID/GID. A retained
controller pidfd and start ticks/cgroup generation are revalidated before and
after transfer and before exec. Receiver must itself reside in the exact
`codex-cli-resource-<UUID>.service` cgroup; controller must be outside that leaf.
The future companion must independently require receiver peerPID==systemd MainPID,
manager-parent/startticks/pidfd binding and exact2GiB/0/64 readback before sending
any fd. This receiver does not replace those controller gates.

A single monotonic5s budget covers setup, frame writes, offer/FD receive and
pre-exec admission. The received socket must be connected AF_UNIX/SOCK_STREAM,
non-listening, matching the offered dev/inode and CLOEXEC. F_DUPFD_CLOEXEC reserves
198 only if unused; an already-received198 is already owned and retained. Any
racing higher result is closed and refused. After ACK, rendezvous socket, retained
pidfd, duplicate received fd and all other nonstdio descriptors close. Only198
becomes inheritable for the fixed exec of timeout200/kill5 -> existing unshare ->
shell --trusted-ingress-fd with replacement PATH/LANG. Receiver exec preserves its
PID/generation for the future systemd binding. No generic command or extra fd is
passed. Failure before exec closes all owned fd copies without numeric kill.

39 scoped offline tests PASS. Coverage includes exact args, private path
symlink/owner/mode/inode rejection, peer and cgroup generation, malformed/truncated/
excess ancillary cleanup, one-byte offer framing, occupied198, and mocked full
exec ordering proving channel/pin/duplicate closure before only198 inheritance.
No real SCM_RIGHTS, socket, systemd, namespace, auth, credential or network
operation was performed during this implementation. Runtime needs only Python
stdlib; this offline test file uses pytest. The controller companion, actual
resource admission, executable source binding and all runtime cleanup remain
separate work requiring review before any actual experiment.

## Additive fixed HTTP receiver selector
The exact --http-handoff selector takes the same six bounded UUID/nonce/controller-generation/socket-identity arguments as --handoff. It selects only HTTP_COMMAND, identical timeout200/TERM5/unshare/cleanenv/198 handling with final shell flag --trusted-http-ingress-fd. Original --handoff command and parsed identity shape remain unchanged. No caller command/path/environment or additional flag is accepted. SCM_RIGHTS F/oneFD and ACK semantics are unchanged; HTTP mode is selected by the trusted invocation, not inferred from a received descriptor. Both branches have mocked full exec/FD-cleanup tests; no actual runtime was performed for this addition.
