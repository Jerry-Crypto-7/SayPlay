# Owned systemd ingress rendezvous companion

This module is a fixed controller-side integration component, not a standalone
unit launcher or generic send-FD server. It does not modify the existing relay,
proxy or launcher. Runtime is separately gated; no actual socket/unit operation
was performed while implementing it.

`create_rendezvous(expected_source_hashes)` requires exactly the six names in
SOURCES and compiles their already-hashed bytes: this companion, fixed receiver,
existing resource relay/probe, offline proxy and basic ingress launcher. The last
is reused only for its fixed nonce challenge/read helpers, never for its Popen.
The instance owns a fresh UUID/nonce, private0700 own-runtime directory and0600
AF_UNIX stream listener, plus its own factory-created proxy socketpairs. Existing
paths are never adopted. A created directory/socket whose identity cannot be
captured is unknown cleanup and fences another handoff; it is never unlinked
without the expected inode.

Stable main integration API:

- `.unit`: exact `codex-cli-resource-<uuid>.service` string.
- `.receiver_argv()`: method returning the fixed receiver tuple with generated
  UUID/nonce/controllerPID/startticks/private socket dev+ino. No caller command.
- `.ownership()`: bounded JSON-ready unit/UUID/nonce/controller/path/source identity
  to archive before the caller creates that unit.
- `.transfer(manager_identity, manager_pidfd)`: after caller unit spawn, accepts
  one receiver; reuses the reviewed relay binding and exact resource readback.
  Receiver SO_PEERCRED PID must equal current MainPID; UID/GID, hello startticks,
  retained own receiver pidfd, manager parent/generation and leaf are bound.
  Before the sole F+SCM_RIGHTS send, it rechecks current binding, exact limits,
  own path identity and sources. ACK must exactly name nonce/fd198/socket. A
  positive send followed by missing/invalid ACK is uncertain transfer, never
  permission to retry. MainPID binding is checked again after ACK.
- `.start_route()`: only after successful transfer, starts the fixed authored
  broker/BEFORE/AFTER fixture threads. First ingress readiness waits at most30s;
  then the unchanged proxy2/5s timers begin. No generic endpoints are accepted.
- `.finish_route()`: idempotent and callable before route start or after transfer
  failure. It waits briefly for natural EOF, cancels only its own broker if still
  active, joins within a six-second cleanup bound, closes owned endpoints and
  removes only its exact verified socket/empty UUID directory. It returns separate
  broker, route, threadsClosed, peersClosed, pathCleanup, ownedCleanupVerified,
  sourceStable and fixed NOT_ATTESTED remoteUnitCleanup evidence.

Main must always perform its original own-unit/leaf cleanup, even if companion
transfer or cleanup fails. This component never resets/stops a unit, kills a PID,
claims systemd resource exhaustion or replaces capsule descendant cleanup. A
failed transfer, unknown own cleanup or failed route permanently fences another
constructor in this module instance. Public attributes are trusted-Python caller
state, not a hostile in-process boundary.

Plain HELLO/ACK use bounded recvmsg and reject/close any unsolicited ancillary
FDs. The only outbound ancillary operation sends one byte F and precisely the
owned ingress peer. No retry occurs even if sendmsg fails; metadata/ACK are strict
and version booleans cannot substitute for integers. Setup has a fixed5s deadline,
with checks around blocking reviewed metadata observations; inner200/5, job180 and
manager220/5 limits are untouched. Setup deadlines do not claim atomic cgroup or
privileged-writer resistance. Listener/path/FD/thread cleanup and transferred
receiver ownership remain separate from remote service cleanup.

20 scoped offline tests PASS. They cover wrong peer/hello/ACK, resource and
pre/post MainPID drift, one-send/no-retry, source drift before send, incoming
ancillary rejection, idempotent finish and uncertain thread/source outcomes,
foreign-directory refusal, and captured-identity failure after mkdir/bind.
The main review specifically found the latter creation/metadata gap; explicit
creation flags now preserve unknown state and never silently grant cleanup.
No current tests or source receipts are labeled actual SCM_RIGHTS/systemd proof.

## Additive HTTP factory
create_http_rendezvous(expected_source_hashes) creates the same owned UUID rendezvous with an internal fixed http profile; receiver_argv emits --http-handoff. create_rendezvous retains its original --handoff. There is no caller argv, unit, descriptor or URL parameter. The six exact source hashes continue to bind receiver/relay/probe/proxy/basic-launcher dependencies; helper/image HTTP14 binding belongs to the relay ready/start and child measurement. FD transfer,5s setup, source recheck, MainPID/private-manager/readback, ACK unknown fence,30s first-readable/5s authored broker, path/peer/thread cleanup all remain shared. The outer broker still receives canonical67-byte CONNECT after inner97→67 normalization; its fixed nonce challenge is unchanged. No new general readiness schema or actual systemd run is introduced here.
