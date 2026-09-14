# Credential-free CONNECT precursor

This standalone module implements a runnable nonblocking byte relay over three
explicitly owned AF_UNIX socketpairs. It has no DNS resolver, TCP connector,
listener, TLS termination, authentication operation or subprocess launcher.
`production_upstream()` always raises `PRODUCTION_UPSTREAM_NOT_IMPLEMENTED`, as
does invoking the module as a script. Nothing is integrated into the capsule.

The only accepted negotiation bytes are `REQUEST`: CONNECT fixture.invalid:443
HTTP/1.1, exactly one matching Host header, CRLF and the final empty line. Partial
input is supported, max 4096 bytes. Other methods, authorities, headers (including
proxy/auth headers), body bytes and coalesced early tunnel/pipelined bytes are
rejected. Rejected input is cleared and never included in diagnostics. Once the
fixed 200 response has been fully written, tunnel bytes are opaque: they are
neither interpreted as HTTP/TLS nor logged, hashed or persisted.

`create_offline_session()` returns `(broker, ingress_peer, upstream_peer,
control_peer)`. It explicitly requests AF_UNIX/SOCK_STREAM with no TCP fallback.
All descriptors start non-inheritable. The caller owns and closes the peer ends;
`broker.run()` owns and closes only its three distinct factory-created ends and
may be called once. This is a trusted Python caller contract, not protection
against a caller mutating module internals. Control byte C or control EOF cancels;
other control input refuses. No generic descriptor-adoption API is provided.

The relay bounds each pending queue to 64 KiB and total received ingress/upstream
bytes to 1 MiB, with 2-second negotiation and 5-second session deadlines. These
are offline precursor limits, not changes to the existing production launcher
budgets. Writes are partial/nonblocking, control remains readable under data
backpressure, and EOF half-closes only after pending bytes drain. Counters include
CONNECT input and fixed CONNECT response output respectively, so their sums are
not expected to match. A crossing chunk is counted then refused without relay.
The report includes fixed reasons, counters, elapsed time and owned descriptor
closure only; it does not claim process/descendant cleanup or network admission.
Unknown descriptor cleanup permanently fences further factory sessions in this
module instance. A future capsule controller still needs its independent lifetime
and process cleanup proof; there is no TERM/reap implementation because this
module launches no process.

Validation: 83 scoped tests PASS / 4 SKIP. Native Windows Python has no AF_UNIX
constant here, so the four real local socketpair cases explicitly skip. No kernel
socketpair PASS is claimed. Deterministic selector/socket tests exercised the
actual relay loop: partial writes, EAGAIN, opaque bytes, half-close, input EOF,
backpressure cancellation, deadline, byte cap and owned descriptor cleanup.
Parser tests cover every split in the fixed request and disallowed input classes.
The first run failed collection because `request` is a reserved pytest parameter;
the second was 76 PASS / 4 SKIP / 1 FAIL because an offline factory-failure mock
omitted the unavailable AF_UNIX constant. Both test-only mistakes were corrected;
no fallback socket family or source protection was relaxed.

This implements the isolated authored-peer precursor from
`scratch/session8-next-egress-control-implementation.md`. It does not validate
actual pinned HTTP/WSS proxy routing, endpoint coverage, host egress, credential
operations, aggregate resources or trusted worker FD separation. Those remain
separate prerequisites for any future integration. No external traffic, auth,
model/API server or image integration was performed.

## Review remediation

Two scoped security findings were corrected before any real socketpair run.
Selector construction now occurs inside the owned-endpoint cleanup region; even
constructor failure closes all three broker descriptors and fences another
session if any descriptor remains open. Deadline checks now run immediately after
select and before processing each ready event, with an additional check before
EOF success sealing. A delayed selector cannot admit CONNECT or forward data after
the fixed 2/5-second boundaries. These changes do not extend either limit.

Updated scoped validation: 87 PASS / 4 SKIP. New deterministic negatives inject a
selector-constructor failure with known and unknown FD cleanup, and delayed select
at both exact deadlines; they assert no recv/send occurs after expiration. Native
Windows AF_UNIX remains unavailable, so the four real socketpair tests still have
no kernel credit. The test file requires pytest (no third-party runtime dependency
for the proxy itself). A later explicitly authorized clean-env WSL run can use
Python -B -m pytest -q --tb=short --import-mode=importlib -p no:cacheprovider on this
single test file if pytest is already available; nothing was installed here.
