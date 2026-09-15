# Full ordinary generation and product materialization

`runOrdinaryGenerationSession` runs one frozen development attempt through
`runOrdinaryGeneration` (the actual intent/compiler/repair core), then passes its
validated blueprint directly to the existing browser bridge. It does not call
the older provider-only runner or issue another model request for materialization.

The additional `ordinary-generation-session-v1` record binds the generation hash,
freeze time and browser timeout. The experiment, grammar and input bytes are
copied and checked before dispatch. Separate generation and browser sinks preserve
per-call requests/responses, rejected repair rounds, fresh frame/input observations
and cleanup evidence. The bridge's raw bytes are **compiler-derived JSON**, not a
verbatim provider response; the binding record explicitly retains that distinction.

There is no default production transport. A live capability still requires the
existing trusted-caller production readiness checks before every dispatch. A
fixture capability stays fixture through the browser and makes zero model calls.
Neither scripted browser operation nor schema acceptance earns human, live
benchmark or independent semantic credit. All such report fields remain NOT_RUN.

This is one attempt, without implicit retries. The generation transport currently
does not return a local process cleanup receipt, so a live session always leaves
`nextDispatchAllowed:false`; browser cleanup cannot establish provider cleanup.
If generation throws without returning its accounting, live model-call count is
null and termination unknown. Successful fixture materialization may be repeated
only after observed browser cleanup and without cancellation.

Targeted integration evidence is recorded separately from real browser runs:
`scratch/session7-generation-session-integrated-unit.json`. Mock browser samples
in unit tests are synthetic; they are not rendered-frame observations.

The separately executed browser measurement is
`evals/reality-compiler/ordinary-generation-session.measure.ts`. Its session 7 run
passed two predeclared fixture scenarios (normal and one repaired compiler round)
through the real core, prompt/SSE product bridge, drawn frame and scripted UI
action. Both contexts were closed; model calls are zero. See
`scratch/session7-ordinary-generation-browser-validation.json`. These fixture
durations are not a measured model optimization or independent semantic result.
