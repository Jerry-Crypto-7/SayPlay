# Separate trusted ingress socket-role probe

Fixed `/work/trusted-ingress-boundary.json` adds trustedIngressSocket:{dev,ino,
type:S_IFSOCK} alongside the original four FIFO roles. The old marker/validator
is unchanged and rejects this schema. Fixed NOFOLLOW/NONBLOCK directory/file
reads require bounded regular file, readonly mount and stable metadata. File
mode alone is not mount evidence.

A private source-bound old-probe instance supplies collection and strict checks.
The new kind is FIXED_TRUSTED_INGRESS_BOUNDARY_OBSERVATIONS; only a private kind
validation view is normalized for reuse. Actual marker bytes/hash/socket role,
path results and the returned report are never stripped or replaced.

It requires worker fd0–2 only, fresh self/proc1 PID namespace, mount separation,
lockdown status, original four HOME/sentinel paths and proc1 fd0/1/2 plus fd198.
All standard/successfully opened descriptors must differ from the socket and
four FIFOs. An extra inherited fd198 fails. Protected accesses are O_RDONLY
open-only, zero body reads/writes. Fresh local proc FD opens may succeed only
when nonalias; success is not labelled denial. Absence and denial stay distinct.

The separate gate/trampoline profile grants the exact readonly marker file and
retains app-server HOME denial. Same synchronous lockdown, nonstandard FD closure
(including198) and four-variable worker environment apply. No descriptor import,
credential operation or syscall relaxation is added. No general hostile-worker,
resource exhaustion or systemd capability-transfer claim follows from this probe.
