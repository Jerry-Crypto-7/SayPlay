# P42 verifier latency investigation

Historical round4 completed measurement: p95 3314 ms, steer mean 2217 ms, walker mean 1600 ms, platform mean 1523 ms. See profile-round4-times.json. Historical results are unchanged.

A separate synthetic CPU profile uses drive+chaser and run+deliver, seed 1, one warmup each then three measured runs each. All six verdicts remained publish eligible; repeated hashes/ticks are identical per world. Both independent replays, idle run, winner and threat runs execute normally. No corpus parser or held-out evaluation was run.

Measured six-verification wall time: 28970 ms. CPU profile: 643 samples; longest sample interval 743 ms. Significant scheduling/instrumentation gaps make these wall times unsuitable as a clean baseline speed comparison.

Self CPU samples by file (not inclusive call-tree time):

- witness.ts: 288/643 (44.8%)
- verify.ts: 89/643 (13.8%)
- kernel.ts: 76/643 (11.8%)
- steer.ts: 40/643 (6.2%)
- contract.ts: 38/643 (5.9%)
- runner-bot.ts: 33/643 (5.1%)
- (garbage collector): 25/643 (3.9%)
- assembly-parts.ts: 22/643 (3.4%)
- steer-bot.ts: 14/643 (2.2%)
- runner.ts: 4/643 (0.6%)

Dominant functions are WitnessRecorder.afterTick, hasMoved and binding. afterTick scans every body every tick and constructs repeated role/body string keys; static rule predicates and movement maps are recomputed. Root owns witness.ts and received a recommendation to replace string movement keys with body/role tracking and hoist immutable predicates, preserving dynamic spawn/role/death semantics.

No verify.ts source change: its mandatory independent replays and physical threat probes must remain, and this evidence does not justify weakening them or adding a potentially stale verdict cache. Existing runBot allocations are smaller contributors than witness processing.

Validation command (one-use artifact, refuses overwrite):

    npx vitest run --config vitest.measure.mts evals/play/p42/profile-verify.measure.ts

Result: 1/1 passed. CPU sampling output: profile-verify-cpu.json.

## Authorized bounded optimization

After ownership transfer, witness.ts now stores movement pairs as Map<roleId, Set<body>>, eliminating both per-body per-tick concatenated keys. It preserves histories for roles sharing/reusing body slots and removes exactly the current role/body pair on death. Immutable knockdown/team/race/stack predicates and movement lookup are constructed once per recorder. The physical goal kick witness added by root is preserved. verify.ts and its publication/replay requirements are unchanged.

Six complete before/after verdict SHA-256 values match, including all inputs, witnesses, change maps, replay result, hashes and eligibility. Drive means: 3348 ms before / 3045 ms after. Run means: 2227 ms before / 3426 ms after. These timings do not establish a speedup: initial baseline overlapped another test and this host had substantial scheduling gaps. The claim is reduced hot-loop allocation and unchanged outcomes, not a measured latency acceptance pass. CPU samples fell from 609 to 459 overall, witness from 230 to 182; irregular sampling prevents treating counts as exact CPU-time reduction. See profile-verify-comparison.json and raw before/after profiles.

## Indexed binding lookup

The next profile-supported change replaces each fallback bindings-array/filter allocation with a constructor-built role-code/kind-name index. Conflicting role identities resolve to null exactly as before; initial body bindings retain precedence. Per-body results, including missing bindings, are cached only while both role code and kind name are unchanged. A reused slot with a changed signature is resolved again. Matching uses kind names rather than numeric indices to preserve the original equivalence relation.

All six complete indexed-verdict hashes equal the pre-change baseline. Mean drive time was 3350 -> 1150 ms; run 2227 -> 1494 ms. Total CPU samples609 ->263; witness230 ->79. These are local directional measurements, not a clean-host acceptance result (baseline overlapped a test and scheduling gaps remain). No replay, proof, horizon or eligibility requirement changed.

Final regression result: 39/39 tests in four files passed (witness.test.ts, witness-movement-history.test.ts, verify.test.ts, ball-kick-witness.test.ts). New cases cover movement returning to origin, death/reset, ambiguous templates, dynamic slot identity changes and direct binding precedence.
