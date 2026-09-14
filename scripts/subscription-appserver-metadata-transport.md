# Actual CLI metadata transport

The explicit `createSystemdAppServerMetadataTransport` variant wraps the shared
fixed systemd metadata pipe broker. Both variants now use one exact RPC admission
and factory busy/unknown-cleanup fence implementation; there is no duplicated
resource broker, caller-selectable executable or runtime fallback. The basic
factory remains resource-unvalidated. The resource variant preserves the broker's
owned-unit/peer/readback/failure evidence and grants aggregate readback credit only
when that broker confirms it. Its first actual integration is separately scoped
in `subscription-appserver-systemd-metadata-transport.measure.md`; historical basic
and authored fixture experiments remain unchanged.

The first actual run remains FAIL at
`scratch/session8-appserver-metadata-pipe-f2bb5ff9-5947-487e-ab59-899188184ba0/summary.json`:
initialize succeeded, then an unrecognized namespace `configWarning` caused the
adapter and bridge parsers to stop before thread/turn. Its cleanup was confirmed;
that does not satisfy the declared metadata/thread/refusal expectation. The new
reviewed advisory-preservation revision changes neither the OS filter nor this
transport's metadata allowlist. It retains the exact raw warning and exposes the
generation adapter's frozen typed advisory record without sandbox readiness credit.

`createAppServerMetadataTransport` implements the existing `GenerationTransportFactory` over the fixed credential-free basic capsule. It has no executable, environment, mode, caller config, home or argv override. It is a limited no-turn metadata transport, not the production dispatcher or the separately measured systemd resource boundary. `aggregateResourcesValidated:false` and `productionReady:false` remain explicit.

Every start requires current SHA-256 identities for the fixed metadata bridge, noenv policy module, worker-lockdown and read-only catalog. The actual bridge starts pinned Codex with fresh exclusive HOME/CODEX_HOME, process-level fixed policy/catalog and no inherited host credentials. Its input is a fixed metadata allowlist with actual response gating. The TS boundary independently admits exactly initialize, initialized, thread/start and optional model/list, in that order and with immutable literal parameters. Its generation-compatible initialize client name and fixed developer instructions match the bridge. No user-supplied prompt is forwarded to a turn. All turn, interrupt, account, auth, environment mutation, unknown method, wrong order or changed parameter requests are refused before any bridge input write. Input snapshots are created synchronously from fixed templates.

The existing generation adapter automatically attempts a turn after validating the actual thread profile. That operation is deliberately refused with `METADATA_RPC_NOT_ALLOWED`; the adapter reports `TRANSPORT_WRITE_FAILED`, not generation success. Its `modelCalls:null` after attempted dispatch is preserved even though this fixed transport never forwards a turn and actual model calls are zero. `fixture_input_ack` is the existing wire name and means only the supervisor wrote bytes to the bridge. It does not prove bridge-to-Codex delivery, inference, or cleanup. A separate model/list client may use request 3; it must not share that ID with the adapter's refused turn request.

Raw stdout/stderr from the bridge remain separate from the supervisor JSONL control envelope. Stdout consists of actual CLI frames; stderr may contain actual CLI diagnostics and an explicitly named fixed `METADATA_PIPE_DIAGNOSTIC` bridge failure marker, all counted as actual pipe bytes, not fabricated CLI responses. UTF-8 envelope decoding is fatal and flushed at close; frame sizes, canonical base64 and byte limits are checked. Aggregate observed counts follow deferred raw callbacks and precede cleanup settlement. Withheld bytes never become invented raw bodies; unknown totals remain null. Raw retention is the unchanged generation adapter 8 MiB cap, maximum job 180 s, outer command 200 s and TERM grace 5 s. The new child loop uses its own 180 s bound, not the historical metadata helper's 12 s experiment. Callback output and late evidence follow the existing adapter contract. Unknown local or remote termination permanently fences reuse of this factory instance; busy instances cannot dispatch concurrently.

Cleanup credit requires validated capsule identity and terminal namespace/pidfd evidence plus local close. Cancellation acknowledgement is not cleanup. This first transport uses the basic capsule; it does not inherit systemd limit credit from another experiment. Codex startup may attempt websocket warmup that the OS denies; no network-inertness or authenticated/allowed egress claim follows. Fixed policy/catalog selection is not proof that every runtime tool registry is empty (the pinned PlanHandler is bookkeeping).

Offline tests use explicit process/response doubles and do not obtain actual CLI credit. Runtime requires joint source freeze and independent review. Historical metadata helper and fixture measurements remain unchanged.

Initial scoped validation was 23 PASS / 1 FAIL: the authored initialize response used an invalid short temporary-home suffix and correctly triggered INITIALIZE_IDENTITY_MISMATCH. The fixture was corrected to the existing eight-character profile; no runtime check was relaxed. Test helper bytes are now explicitly mocked and stable to avoid source-hash races with parallel Python implementation. Actual measurements always hash real current source contents.
