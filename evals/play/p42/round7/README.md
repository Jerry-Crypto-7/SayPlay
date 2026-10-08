# P42 round 7 blind held-out set

64 natural English requests with manual semantic labels in one group, `held-out`: 22 multi-action, 8 paraphrase, 10 negation, 8 unsupported and 16 single – the same ratios as round 6. The paraphrases form two four-variant families (`r7-ho-023` to `r7-ho-026`, `r7-ho-027` to `r7-ho-030`).

An independent subagent wrote the set without access to `src/`, `evals/` or any earlier round result. It received only the row schema, the intent vocabulary (`src/play/intent/contract.ts` axes, copied into its brief) and the round 6 kind ratios. It never ran extraction, drafting, composition or measurement on these sentences.

`dataset-seal.json` holds the SHA-256 of the exact LF bytes, the row counts and the fingerprints of every set checked for overlap (P30, P41, P42 and P42 rounds 2–6, plus the P42 development set). There are no normalized overlaps and no internal duplicates. `evals/play/p42/__tests__/round7-seal.test.ts` re-checks the hash on disk and in git, the ratios, the overlap and that no round 7 sentence appears in `src/`.

The set was sealed before any P44A fix landed. Once round 7 has been measured, its sentences are exposed data: later fixes must not be tuned on them.
