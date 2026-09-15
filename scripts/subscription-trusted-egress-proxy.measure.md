# Stdlib-only AF_UNIX precursor measurement

This fixed no-argument harness compiles exactly the hashed proxy module bytes and
uses only standard-library AF_UNIX socketpairs. It performs six sequential authored
scenarios: bidirectional 1024-byte transfer and half-close ending in EOF; explicit
C cancellation; invalid control; control EOF; the original unshortened 2-second
negotiation deadline; and bounded unread-upstream/client backpressure followed by
control cancellation. No DNS, TCP, provider endpoint or external peer is created.

Normal waits for the broker thread's true EOF terminal before closing the control
peer, preventing the cleanup-finally cancellation race in the original unit helper.
Peers have at most one-second I/O timeouts (the pressure sender is nonblocking).
Each broker join is bounded by its original five-second session deadline plus a
half-second observation margin and the single 20-second overall measurement
budget. No following scenario runs after a failed result or uncertain thread/FD
cleanup. Owned peer closure is reported separately from broker descriptor closure.
Backpressure evidence is an actual would-block from the authored client with the
upstream unread and small owned socket buffers; it is not a general resource
exhaustion proof.

The bounded stdout JSON contains fixed outcome/timing/counter metadata and known
payload hashes, never arbitrary headers or opaque payload bytes. Before/after
hashes cover the proxy source and this harness; loaded module digest must equal
before-source digest. The external caller should archive stdout and exit status.
The runtime entrypoint is `python3 -I -S <absolute-path-to-this-file>` and needs no
pytest, installation or third-party modules. Runtime is authorized separately.

17 scoped offline harness tests PASS. They exercise validators, wrong EOF versus
cancellation, missing cleanup, fixed deadlines, hash drift and no-next-dispatch
fences without creating sockets. No actual AF_UNIX measurement was run during
implementation. Untrusted namespace, process kill/reap, authentication, production
HTTP/WSS routing and external network tests remain explicitly NOT_RUN. The frozen
proxy module was not changed by this harness task.

Setup-cleanup review P2 closed in source: socket timeouts/buffer setup and thread
construction/start now occur inside the endpoint cleanup region. A not-started
broker has all three broker descriptors explicitly closed as well as its peers;
unknown broker closure sets the module fence. The result distinguishes
threadStarted, threadClosed and setupBrokerDescriptorsClosed, with no success
credit for setup failure. Deterministic constructor/start/timeout/sockopt and
failed-close tests bring the scoped suite to 22 PASS. No actual run occurred.
