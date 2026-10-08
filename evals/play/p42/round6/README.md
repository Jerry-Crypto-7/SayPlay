# P42 round 6 blind held-out set

This independently authored set contains 64 natural English requests with manual semantic labels. Its only group is `held-out`: 22 multi-action, 8 paraphrase, 10 negation, 8 unsupported, and 16 single requests. The paraphrases form two four-variant families (`r6-ho-023` through `r6-ho-026`, and `r6-ho-027` through `r6-ho-030`).

Authoring used only the P42 specification, the intent contract, and programmatically inspected structure/counts from P41. No parser, composer, runtime, prior sentence content, evaluation result, or report was inspected. The old strings were read only inside the mechanical overlap check, without displaying their contents. All groups in P30, P41, P42, and P42 rounds 2 through 5 were checked. There are no normalized overlaps or internal duplicates.

Labels were manually reviewed for grammar, singular noun heads, actual setting heads, threat direction, known versus unknown actions, projectile target versus ammunition, and negation scope including positive ?don't stop? requests. Unsupported labels record explicit unknown base verbs. Compatible or incompatible combinations of known mechanics remain supported semantic requests.

`dataset-seal.json` records the exact-byte SHA-256, row counts, overlap-source fingerprints, and pre-execution authoring declaration. The author has not invoked extraction, drafting, composition, or measurement on this set. The measurement runner belongs to the primary agent and was not read or modified here. Keep the sealed dataset unchanged after evaluation begins; any subsequent implementation work must treat these requests as exposed data.
