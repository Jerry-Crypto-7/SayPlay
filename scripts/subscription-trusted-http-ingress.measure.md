# Authored local HTTP ingress measurement

This Linux stdlib-only harness exercises the standalone HTTP adapter using
genuine numeric loopback TCP and AF_UNIX socketpairs. It accepts no arguments,
does not resolve DNS and has no external, credential, model, capsule or worker
exclusion credit. No actual run has been performed for this harness yet.
Runtime requires the separately coordinated source freeze/review and handoff.

Six fixed scenarios are declared before runtime:

1. Three authored CONNECT writes, two actual broker response writes, then opaque
   bytes and both half-closes. These are authored write fragments; the kernel
   may coalesce them. The client must receive the actual 39-byte response,
   both opaque bodies must match, both EOFs must be observed, and no queued
   bytes may remain.
2. Wrong fixed CONNECT host: no request bytes forwarded to ingress and no
   fabricated response returned to the client.
3. Actual authored 403 response: the exact request reaches ingress, but no
   synthetic 200 reaches the client.
4. Cancellation while ingress is not being drained after handshake. A bounded
   512 KiB client burst and at most 100 ms send window plus 50 ms scheduling
   window precede C on the owned cancellation socket. PASS requires actual
   nonempty retained ingress queue and observed bytes exceeding delivered
   bytes. If backpressure is not observed, this scenario fails; it does not
   receive pressure credit merely because cancellation succeeded.
5. No handshake bytes: the original two-second negotiation deadline must fire.
   This is a real deadline scenario, not a reduced test clock. All scenarios
   retain the original five-second session budget from factory admission.
6. The separate `create_pinned_wss_fixture_session` sends the exact 97-byte
   source-shaped request with `Proxy-Connection: Keep-Alive`. The broker must
   actually receive the canonical 67-byte request, followed by unchanged opaque
   bytes and half-close EOF. Client observed bytes and broker delivered bytes
   differ by exactly 30, recorded as `normalizedHeaderBytes: 30`. The original
   five scenarios retain `profile: authored-connect` and zero normalization;
   this sixth uses `profile: pinned-wss-shaped-fixture`. No byte conservation is
   claimed across that normalization and no real CLI, WebSocket or TLS run is
   implied by authored source-shaped traffic.

The factory creates and connects the sole loopback client; no endpoint is
adopted. Only the adapter runs on one harness thread. The harness owns the
returned client/ingress/control peers and closes them even if thread start
fails. In that case it also calls the session's idempotent close method.
Thread joins are bounded; a live thread or mismatched metadata-only process FD
inventory is unknown cleanup and blocks every later scenario. No signal,
process kill or retry is used to manufacture cleanup.

Each unique scratch receipt archives the two exact source files before runtime
and records before/after hashes, actual sent/received bytes as hex with counts
and SHA-256, adapter observations/delivery/retention, identities and cleanup.
Counts distinguish harness writes, adapter receives and adapter deliveries.
Retained adapter bytes are counts, never fabricated transcript bodies. Fixed
raw buffers are bounded; failed or incomplete captures remain failures.

Offline tests use independently authored structured observations and mock only
the harness lifecycle. They do not provide kernel, HTTP client, integration or
runtime compatibility credit. Meaningful negatives cover fake 200, wrong
forwarding, absent pressure, early timeout, identity alias, raw/accounting drift,
partial cleanup and startup failure. The initial scoped suite passed 24 tests;
final completeness checks add missing-retention and partial-close regressions.

Before the additive normalization change, all three baseline harness files were
archived in `session8-http-measure-baseline-ba6aa4e9-2776-4fe6-8178-2e4d180922f5`,
receipt SHA-256 `47862427931632d8a23b3568b84d5eb71661f807e88266376f2ae28c8e8d1751`.
The baseline had 26 offline passing tests and no actual run. Pinned serialization
source evidence is separately recorded in
`scratch/session8-pinned-wss-connect-shape.md`; this harness imports no downloaded
client code and broadens no general-purpose parser.
