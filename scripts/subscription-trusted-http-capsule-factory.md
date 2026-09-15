# Fixed capsule HTTP factory (not integrated)

This callable helper duplicates only the already provisioned FD198 after exact
socket identity, connected AF_UNIX stream, non-listener and CLOEXEC checks. It
does not consume the original descriptor. The caller retains FD198 on success
and failure, must bind and close it before a worker spawn, and must include it
in its own final cleanup. Invalid identity never closes an unrelated original.
Only the verified duplicate belongs to the session.

The duplicate shares the original socket's open-file description. Setting its
nonblocking mode therefore also sets O_NONBLOCK on the verified original FD198.
The trusted caller must coordinate that state; this is descriptor ownership
separation, not an independent copy of the socket state. Unverified originals
are neither closed nor reconfigured.

The helper loads exact reviewed HTTP core `9abe08ec…` from a fixed readonly
runtime path. A private module instance tightens its existing two/five-second
deadlines to the caller's remaining absolute shared deadline; it never extends
them. Loading and setup count from factory entry. The caller's absolute deadline
is a trusted orchestration contract, not an independent clock attestation.

The helper creates one numeric loopback listener, its one bound client and one
AF_UNIX cancellation pair. It returns `(session, client, control_peer)`. The
session owns listener, validated ingress duplicate and cancellation endpoint;
the caller owns the returned two peers and still owns original FD198. All
partial setup endpoints are cleaned on failure. Session unknown cleanup also
fences later factory calls, even though each call loads a private core module.

The listener remains open until `session.run()` accepts its sole client. A
future capsule profile must verify the same listener remains live before and
after the worker's exact negative connect, then run the protocol. Ownership
includes the listener/client/control/ingress socket tuples and network namespace
needed for a separate readonly marker. No accepted tuple exists before accept.

There is no runnable default entrypoint, no arbitrary FD/listener/destination
adoption, no external connector, no credential access and no subprocess launcher.
The selected protocol is the fixed 97-byte source-shaped WSS fixture normalized
to the 67-byte fixture broker request. This is not an actual WebSocket client.

The helper is not copied into the current capsule image, selected by a launcher,
or granted any actual FD198, network isolation or process cleanup credit. It
still needs a reviewed child/profile and combined runtime validation.
