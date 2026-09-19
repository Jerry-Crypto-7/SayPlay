# WORLDSTREAM – a counterfactual world compiler

Describe a place in one sentence, act inside the world it compiles to, rewind, change one of its laws in words, and compare two synchronized futures side by side.

**Submission description, not yet published, 19 September 2026.** Focus category: procedural worlds. Registration and public submission are not verified; this text does not claim that the remaining product gates are passed. Video production dependencies and their licence notices are listed separately in [the video asset manifest](../../videos/worldstream-a4/third-party-assets.json); the application's own registry is [DISCLOSURE.md](../../DISCLOSURE.md).

## What the judge does

The sentence never becomes code. A planner turns it into a plan, a compiler turns the plan into a WorldDoc of declarative rules, state and geometry, and a deterministic runtime checks that document, searches for a winning path and runs it at 20 ticks per second with no real-world time inside the hashed state. Geometry is hybrid: 30 first-party models, parametric architecture and terrain, and SDF shapes meshed in the browser for forms the catalog does not have.

On the main page **Generate my world** is the default and starts one live session for the judge's own sentence. Rough masses guessed from the words of the sentence appear before the planner answers and are labelled as guesses; a provisional layout is noninteractive until the rules are accepted. An identical sentence reuses the model's earlier answer and says so on screen. **Prepared demo** is a separate labelled choice, including for exact matches, and an unavailable live service never returns a prepared world in its place.

Once the world is accepted the judge acts in it. Every tick in which a rule fired gets a **Why?** marker on the time axis. Clicking one opens the Why panel, which reads the rule firings the runtime recorded beside the state: the visitor input at that tick, which rules fired, whether their condition held, what each rule wrote (`slot: before → after`), and which rules read those values within the next 20 ticks. Rewinding before that tick empties the panel, because in the rewound state nothing happened there.

**Before my last action** rewinds to the tick before the judge's input. The judge writes one change to an existing rule in plain words; the model proposes the edit, the runtime validates it, and the proposal is shown before confirmation. After confirming, both futures run from the fork with the same inputs, shared time and camera (two views on desktop, a switch on mobile). The difference between them is written from the state diff, not by the model: the outcome of each future with its tick, the first tick at which they part, and up to three values that differ most, named after the blueprint's own entities. Each accepted change stays in a list of up to six futures, any of which can be compared against the original.

The comparison supports bounded compatible changes to an existing rule condition, action or timer; unsupported structural changes are refused with a stated reason. The alternative is accepted as `comparison-only` with no new winning certificate, and can be compared even when it does not win. A rule can also bind a world variable to a look preset (day, dusk, night, storm, fog), so a rewritten rule can darken the sky or start a storm without touching the hashed state.

## Evidence

The [90-second video](../../videos/worldstream-a4/worldstream-a4-live.mp4) (on this machine only, not published) records one real live reading-room generation and a model-proposed terminal change on 17 September 2026. In that single observation the accepted world took **258.445 s** and the rewind-change-compare path **8.555 s**. Both futures were `won`; the terminal's signal was on in one and off in the other. The first 260 seconds of source footage are openly sped up 5×; browser footage was captured at 800 × 450, the closing screenshot is 1920 × 1080. The Why panel, the diff sentence and the list of futures were added after that recording and do not appear in it.

Measured on 19 September 2026 in one live run of two sentences: planner median 59.9 s, compiler median 164 s per call; one of the two sentences reached a playable world. Replaying the archived 30-sentence run, the model's own hero geometry passed the mesh gate for 20 of 30 sentences. The gate for a second sentence that adds an object or changes a rule accepted 2 of 3 attempts at a median of 30.6 s. The 30 models cover 0.446 of the object-kind demand in a 120-sentence judge corpus with human-written oracles.

## What this does not claim

This is an automated production-browser demonstration, not an independent human study, a public-service claim, a percentile measurement or evidence of general prompt fidelity. The latency target was not met by any observation so far. Visual quality, broader generation reliability, human evaluation, provider and hosting evidence remain separate open requirements. Structural checks, a found witness and an equal replay hash cannot certify the meaning or appearance of a generated world, and an exhausted search is not proof that a world cannot be won.

[Video provenance and QA](../../videos/worldstream-a4/README.md) · [Judge runbook](../demo/judge-runbook.md) · [Third-party disclosures](../../DISCLOSURE.md)

---

<details>
<summary>Historical pre-P20 description – retained for provenance, not current product claims</summary>

The text below is superseded. Its SDF-only model, automatic authored substitution, unlabeled exact matches, dev-only branching and pending-final-video statements do not describe the current product.

# WORLDSTREAM

> Draft status, 17 September 2026: the paragraphs below describe the earlier submission baseline and are not ready for publication. Current work uses a hybrid GLB/PBR, parametric and SDF compiler and main-page A4 comparison with synchronized futures. Prepared worlds remain labeled even for exact matches. Public runtime, new live acceptance results, human review and final video are pending. Registration remains unverified. Replace the historical claims below only after the current variant is accepted; do not submit this draft as a completed product description.

**Focus kategorie:** procedural worlds

Registration is not verified.

A sentence in plain English becomes a 3D world you can look at and that runs. The model writes two declarative programs – the composition of the space, and the shape of its hero objects as signed distance fields that the browser meshes itself. A deterministic runtime executes those rules; the model never runs generated code. A second sentence changes one object of the world that is already standing, instead of building a new one.

Judges type their own sentences, so the product is built to answer a sentence it has never seen. A sentence the store does not recognise is answered by the nearest authored world, and the product labels that substitution on screen instead of passing it off as fresh generation. When a sentence is recognised exactly, no such note appears – the note belongs to substitution, not to every world.

The second sentence has an authored change for only 5 of the 11 stored worlds; any other target is refused with a stated reason rather than a borrowed error about a model outage that never happened. Time rewind and branching futures are built and tested, but they are not on the judge's path; they live on a development route only, and nothing in this submission should be read as a claim that a judge can rewind time.

Measured on 13 September 2026 over five sentences against the cloud model: 2.4 model calls per sentence, a median of 143 seconds to a finished world, and a 95th percentile of 259 seconds. Over a separate 30-sentence run the model authored the hero geometry for 0.3 of the attempts; the rest fell back to composed kit pieces or to clay. Creation timings include process and transport overhead, and the judge-path timings were measured over the authored store, not a live model. Geometry is schematic.

A world that passes every structural check does not certify semantic correctness: the runtime proves that the rules are consistent and that the world can be won, never that it means what the sentence meant. The most recent internal review recognised 2 of 10 rendered rooms from the sentence that produced them, which is the measured size of that gap today.

The live model path currently runs only from the author's development machine through the Codex CLI; when that path is absent the hosted deployment answers from the authored store. Independent semantic review and usability evidence from people outside the project remain separate requirements, and neither has been collected.

Third-party libraries, assets, models, datasets and APIs are disclosed with source, author, licence and required notices in `DISCLOSURE.md`.

</details>
