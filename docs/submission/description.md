# worldsmith – a sentence is compiled into a world, and the world carries its own proof

**Focus kategorie:** procedural worlds

You type one English sentence. Within about two seconds a 3D world is standing in
front of you, built piece by piece so you can watch it happen. Next to it, in
plain sight, is the program the world was compiled from – not a chat log, but the
two declarative documents the pipeline actually executes. The system then finds a
winning route through the world on its own and plays it back. Then you rewind
time, change one rule in the past, and watch the future recompute from that
point.

The qualifier belongs right here, next to the claim: **nothing in this system
writes code or control flow.** A world is two declarative branches of an
intermediate language – a rule graph (events / conditions / actions) and a typed
geometry program. Both are executed by a hand-written deterministic interpreter.
Everything a judge sees running is that interpreter.

## What actually happens between the sentence and the world

1. **Frozen corpus, exact text.** If the sentence matches a frozen prompt
   exactly, the pipeline serves the emission stored with it. A near match is
   never passed off as an answer – anything else is an honest "I have no source
   for this".
2. **Deterministic recogniser.** Every other sentence, including anything a judge
   invents, is handled by a recogniser built from English regular expressions,
   which maps sentence shapes onto an emission. No model call, no network, no
   per-prompt cost.
3. **Guaranteed room.** If no shape matches, the sentence still produces a
   playable world with a winning trace, rather than an error or an empty canvas.
4. **Compile.** The geometry program is compiled into real `BufferGeometry`
   under hard budgets. The rule graph is validated against a schema.
5. **Certify.** A search looks for an input trace that reaches `win()`, and the
   authoritative runtime replays that trace before the world is accepted.
6. **Build.** The world assembles in front of the viewer over simulated ticks –
   not a loading screen, and not a pop-in.
7. **Rewind.** The timeline keeps state snapshots, so you can jump back, disable
   or edit a rule, and the future is recomputed from the snapshot.

Live editing is a transactional patch applied to the running rule graph. The
world is not reset and not rebuilt.

## The in-browser model was built, measured, and then switched off

This is the part most worth reading, because it is the decision the measurements
forced rather than the one that would look best.

A language model running fully in the browser was built and wired to the same
emission contract as everything else – WebLLM with Qwen3-1.7B on WebGPU, no key
and no server. It was then measured over the first 40 sentences of the frozen
corpus. On its own it produced **zero** schema-valid emissions out of 40. With
the deterministic recogniser running first, the same measurement gives **0.375**,
with 0 crashes and a median latency of 36 704 ms; one fully bound emission takes
roughly three minutes on this hardware.

So the model is disconnected from the deployed demo. Close to a gigabyte of
weights was being downloaded for a capability nothing called. The code was not
deleted – what is missing is the wire, not the ability – and two conditions are
written down for reconnecting it: the emission has to get fast enough to sit in
front of a judge, and a measured repair has to land first, where the collision
box is derived from the socket instead of being written by the model. That repair
is measured at 27 of 28 parsed emissions passing the schema.

A cloud branch exists for machines without WebGPU. It is off in production, and
because it is off, the demo costs nothing per prompt and cannot be made to spend
money by a prompt.

## The guarantee, quoted exactly as it is written in the design document

The binding wording is Czech, because that is where it is defined, and softening
it in translation is exactly the failure this project guards against:

> **Každý potvrzený graf nese konečnou přípustnou vstupní stopu, kterou autoritativní runtime s připnutou verzí přehrál z kompletního hashovaného snapshotu odpovídajícího zobrazenému stavu — včetně skrytého stavu, front, fáze časovačů a seedu — až do `win()` v deklarovaném tikovém horizontu. Certifikuje to výhradně tento přesný replay, ne vyčerpávající, časově robustní, napříč-runtimovou ani obecně lidskou hratelnost.**

In English: every confirmed graph carries a finite admissible input trace, which
a version-pinned authoritative runtime replayed from a complete hashed snapshot
of the displayed state – hidden state, queues, timer phases and seed included –
all the way to `win()` inside a declared tick horizon. That exact replay is the
whole certificate. It does not certify exhaustive playability, robustness to
timing, portability across runtimes, or human playability in general.

That is a deliberately narrow promise. It is narrow because it is the one that
can be checked, and it is checked on every world before the world is accepted.

## Measured, not estimated

Every number below comes from a report file committed in the repository. The last
section says which file each one is in.

- **Hostile input.** 70 sentences from the contradictory, nonsense and
  other-language buckets of the frozen corpus: **0 empty scenes, 0 exceptions,
  0 waits over the 20 000 ms budget**, slowest sentence 28.32 ms. All 70 worlds
  were playable to a win via their own trace. Six were handled by shape
  recognition; the other 64 fell back to a guaranteed room.
- **Geometry budgets.** 20 of 20 programs under the caps. Heaviest world 2 272
  triangles against a cap of 120 000; slowest compile 16.6 ms against a cap of
  120 ms.
- **The four visual families are actually different.** Mean divergence across
  families 0.435 against a threshold of 0.3, over 28 pairs rendered on real
  WebGL2 from two fixed camera angles. Inside a family, pairs sit between 0.003
  and 0.068 against a ceiling of 0.15 – so a family reads as a style, not as
  noise. Palette alone does not carry it: the weakest cross-family silhouette
  profile is 0.028 against a floor of 0.02, and that floor exists because a
  measurement on 21 August showed two families could share a silhouette and still
  pass on colour.
- **In-browser model.** Zero of 40 schema-valid on its own; 0.375 with the
  recogniser in front; median latency 36 704 ms; 0 crashes.
- **Rejected edits.** Retargeting a patch to its nearest legal variant moved the
  share of applicable frozen patches from 0.35 to 0.4. It did not move the
  fulfilled count, and the report says so instead of claiming a win.

## What this system cannot do, and why

This matters more than the list of things it can do, because judges are
explicitly allowed to test with prompts outside the chosen focus area. A refusal
with a concrete reason is the honest answer, and it never leaves an empty screen:
the visual path still builds a scene even when the rule path declines.

- **Rigid-body physics.** Continuous dynamics has an infinite state space and is
  chaotic, so a found trace does not replay identically; float determinism across
  browsers is not guaranteed either. A fixed step, a fixed solver iteration count
  and quantised state would fix the replay, but not the search.
- **Open-ended dialogue.** Generating free text at play time breaks the time
  budget and cannot be verified. What is built instead is bounded: characters get
  a small mind – two memory slots and ordinary event / guard / action rules – so
  "the character remembers" means a flag, not a language model.
- **Data visualisation.** A chart needs real numbers, readable axes, correct
  scale and legible text. That is a visualisation renderer, a different
  discipline from a game grammar. Live or arbitrary-schema data stays refused.
- **Free-form building.** Player-authored geometry means an unbounded entity
  count, which breaks the finiteness the certificate depends on.

Two more gaps are measured rather than argued. Over the 40 frozen records the
distribution is 6 fulfilled, 27 robust, 4 no-fit and 3 faults, against a frozen
threshold of 24 fulfilled. That threshold is not met, the report says so in its
first line, and three named causes are written down: counting inside a zone made
of three rectangles is not expressible in the intermediate language; one world
never reaches a win inside its horizon; one world never reaches a loss along any
trace it declares.

## Why the pipeline is visible instead of hidden

A generator that hides its output can only be judged on the picture. This one
shows the emitted program, the compiled geometry, the rule graph, the certified
winning trace, and the recomputation after a rule changes. When something is
wrong, you see the wrong thing and you see the gate refuse it. That is the part
worth looking at.

## Where the numbers come from

- Hostile input: `evals/hostile-report.json`
- Geometry budgets: `evals/geom-budgets.json`
- Visual family divergence: `evals/family-divergence.json`
- In-browser model: `evals/local-model/grammar-report.json` and
  `evals/local-model/decision.md`
- Rejected edits: `evals/reject-causes.json`
- Fallback efficacy: `evals/fallback-efficacy.json`
