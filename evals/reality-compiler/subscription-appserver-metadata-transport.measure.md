# Actual metadata stream and deliberate turn refusal

The advisory-compatible experiment additionally requires exactly one actual
`configWarning` with the pinned namespace summary and null details, matched to
the returned typed advisory and timestamp. It never strips or rewrites the raw
frame. The previous actual run at
`scratch/session8-appserver-metadata-pipe-f2bb5ff9-5947-487e-ab59-899188184ba0/summary.json`
remains FAIL (initialize followed by unrecognized warning, no thread/refusal).
The new source profile is a separate compatibility experiment with the same
predeclared 30 s metadata budget; an advisory does not validate a sandbox or tools.

Opt in only after joint source review and main-agent runtime handoff:
`RC_APPSERVER_METADATA_PIPE_SMOKE=1`, then run
`node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/reality-compiler/subscription-appserver-metadata-transport.measure.ts`.
Without opt-in the test is skipped. The predeclared budget is 30 s under the original 180 s maximum; this is one metadata/cleanup scenario, not a model-generation experiment.

The real generation adapter drives initialize and a fixed ephemeral thread over actual pinned app-server pipes. The fixed transport refuses its subsequent turn/start before OS input write. PASS requires the precise expected refusal, actual initialization/thread response bytes, no observed turn, and confirmed local plus capsule namespace/pidfd cleanup. A generic profile failure or timeout is FAIL. Actual model calls are zero; adapter attempted-dispatch accounting remains `modelCalls:null`. No model/list request is interleaved with the adapter's request ID 3.

New UUID artifact directories under `scratch/session8-appserver-metadata-pipe-*` preserve planned expectations, bounded raw stdout/stderr, normalized failure/accounting, received metadata evidence, late evidence and before/after source hashes. Hashing is not an atomic snapshot. Runtime identity comes from the reviewed capsule ready receipt. Failure reports remain separate and no failed experiment triggers an automatic whole-job retry.

This is the explicitly reviewed basic capsule, with no aggregate resource validation credit and no replacement of the separately measured systemd boundary. It performs no authentication or credential reads, host HOME mount, inference, fresh syscall denial sweep, browser work, or general hostile-descendant validation. Automatic startup websocket attempts may occur and be OS-denied; retained stderr is evidence, not proof of network-inertness. Source policy/catalog checks do not independently expose the full live tool registry. Historical PASS/FAIL receipts remain unchanged.
