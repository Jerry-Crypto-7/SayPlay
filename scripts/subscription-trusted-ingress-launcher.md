# Fixed trusted ingress descriptor launcher

The Linux-only no-argument launcher loads the exact hashed offline proxy source,
creates its three owned AF_UNIX socketpairs and provisions only ingress fd 198.
It first requires fstat(198) to fail EBADF, then uses F_DUPFD_CLOEXEC with minimum
198. If concurrent allocation yields a higher number it closes that owned result
and refuses; it never overwrites an occupied fd. Original/duplicate dev/inode,
socket type, AF_UNIX/SOCK_STREAM, connection and non-listening checks precede spawn.

The flushed `ingress_ownership` JSON precedes Popen and contains version1, nonce
(32 lowercase hex), fd198, socket{dev,ino,type49152,family1,socketType1}, and source
hashes. Pipe flush is not durable archival acknowledgement. The fixed command is
timeout TERM200/KILL5 -> existing unshare user/mount/net/pid/UTS flags -> existing
shell with literal --trusted-ingress-fd. Popen inherits stdin/stdout/stderr, has
close_fds=True and pass_fds=(198,) only, and replaces its environment with fixed
PATH/LANG. The outer duplicate and original ingress socket copy close after spawn.

Main's separate shell/supervisor profile must verify/preserve this exact socket,
then transfer it to the fixed trusted child. Main start contract is mode
trusted-ingress-boundary, exact ten helper hashes and nonce. Runtime ready carries
trustedIngressFd; private child startup ingress{fd,nonce,socket} is externally bound
to ownership by the independent measurement. Trusted setup utilities are explicit
bootstrap recipients, not evidence that only the eventual child ever held fd198.

The broker waits for first ingress readability up to30s, then starts the unchanged
reviewed proxy's 2-second negotiation/5-second session. Child sends the fixed
proxy REQUEST/receives RESPONSE. Opaque authored challenges are BEFORE nonce LF
then AFTER nonce LF; replies are ACK + the exact challenge. Child performs these
immediately before/after the fixed worker, while the trusted control is alive,
then half-closes. The fixture waits for real EOF and half-closes its reply stream.
No DNS, TCP, listener, TLS decrypt, provider, auth or model operation occurs.

Only the launcher writes ownership/terminal frames; broker threads never write
stdout. `ingress_terminal` is emitted after known capsule wait (or pre-spawn
failure). A 205-second wait covers the existing200+5 command bound and is not a new
remote cleanup guarantee. Unknown wait suppresses stdout terminal to avoid
interleaving a live capsule writer; no potentially blocking diagnostic fallback is used.
Owned direct child pidfd is retained where admission succeeds; failure still waits
for the already-started command. No numeric fallback kill or global cleanup is
performed. Descendant cleanup remains NOT_ATTESTED_BY_LAUNCHER and must be proven
by the independent supervisor terminal. The launcher is single-use; unknown
thread/socket outcomes cannot lead to another dispatch in this process.

Source inventory includes launcher/proxy/shell/supervisor and the ten exact mode
helpers. Before/after hashes are observations, not atomic executed-byte attestation.
This basic transfer has no systemd aggregate-resource credit. The runtime helper
still requires independently reviewed fixed image/pivot/child/worker changes.

16 scoped offline tests PASS. They cover occupied/racing fd198, non-socket and
socket identity/listener/connection rejection, exact challenge bytes, fixed argv,
source-owned spawn ordering and failures before/after spawn. The first expanded
mock suite was14PASS/2FAIL because it expected one socket-object close where the
actual idempotent ingress close occurs after spawn and again in finally; test
expectations now reflect both calls. No socket runtime, CLI, namespace, auth or
image integration was executed by this task.


## Bounded frame emission review fix

Ownership and terminal frames now use actual nonblocking os.write calls with a
fixed two-second deadline per frame and at most16KiB encoded bytes. Partial writes
and EAGAIN preserve offset; a delayed writable notification cannot cause a write
after the deadline. Original stdout blocking flags are restored before the child
inherits stdout. Ownership must be completely written before Popen. Failed or
partial ownership prevents spawn, closes the owned fd/socket endpoints and emits
no further frame into the partial JSON stream. Terminal emission failure yields
exit1, never success, and there is no write/flush fallback on stdout or stderr.
Pipe completion remains distinct from durable reader acknowledgement.

Updated scoped validation:21PASS, with partial/full-pipe EAGAIN, delayed selector,
ownership emission failure before spawn, owned endpoint cleanup and terminal
failure after known capsule wait. This closes the blocking-output review P2 in
source; no actual runtime was run by this change.
