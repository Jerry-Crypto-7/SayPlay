# Offline app-server generation/core measurement

Opt-in command (PowerShell):

```powershell
$env:RC_APPSERVER_GENERATION_CORE='1'
node_modules/.bin/vitest.cmd run --config vitest.measure.mts evals/reality-compiler/appserver-generation-core.measure.ts
```

One test predeclares three scenarios before executing them: normal, one rejected
compiler response followed by repair, and unknown remote cleanup which fences the
next adapter dispatch. It invokes the real buildIntentRequest/readPlannerEmission
and compileWithRepair core with the fixed app-server generation state machine.
The transport is an in-process synthetic JSONL factory. It reconstructs the
UpstreamRequest from the actual outbound developerInstructions and text input,
then supplies an explicitly disclosed authored fixture through split raw byte
chunks. No CLI, process, credential, account RPC, network or model is used.

The repair fixture is a nonempty malformed object: the adapter accepts its JSON,
then the real compiler rejects it and constructs a repair request. This distinguishes
protocol acceptance from compiler acceptance and preserves the failed round.
The unknown-cleanup scenario supplies a valid compiler result but simulated remote
cleanup unknown; compilation becomes unavailable and the same adapter refuses the
next explicit invocation without opening another fixture transport.

Each scenario shares one 180000 ms monotonic budget across planner/compiler/repair.
Each adapter call receives only the remaining budget and the same AbortSignal.
The harness checks remaining budgets never increase and completion remains within
the chain deadline. This short fixture run is not a measurement of the full
180-second deadline, process cleanup or adversarial OS isolation.

Artifacts are created exclusively under a new UUID in
`scratch/session8-appserver-generation-core/`. The harness archives frozen inputs,
source bytes/hashes before and after (all nonignored src paths plus adapter,
harness, package/config files), requests, outbound frames, wire JSONL, stderr,
generation text, normalized JSON, core validation and repair rounds, derived
blueprints, phase durations and late evidence separately. Wire hashes never stand
in for generation text or derived blueprint identity. Failed scenarios are
preserved and do not prevent the other independent declared scenario from running.
Before/after hashes establish observed stability, not an atomic snapshot or a
historical build attestation. No build or browser is launched.

Adapter `modelCalls` remains null after every fixture turn dispatch and
`observedTurns` counts matching notifications. The separate actualModelCalls and
actualProcessStarts are zero because the factory is synthetic. Confirmed fixture
cleanup means only its promise contract, not an actual process tree. These results
cannot close production readiness, inference, live browser, independent review or
before/after optimization acceptance criteria. Existing browser evidence keeps its
original source/build and historical timing.
