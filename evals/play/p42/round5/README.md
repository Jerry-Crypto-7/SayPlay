# P42 round 5 held-out set

64 independently written English game requests with manual semantic labels. The only dataset group is `held-out`; `kind` records the fixed category split: 22 multi-action, 8 paraphrase, 10 negation, 8 unsupported, 16 single.

Authoring used only the P42 specification, the intent contract, and a structural keys/types/counts inspection of P41. Prior sentences, implementation, outcomes and reports were not viewed. The paraphrase category contains two manually equivalent families of four. No extractor, composer, draft generator, runner or tests were executed by the author.

Labels were manually reviewed before sealing. They preserve singular noun heads and the actual setting noun. Swimming and flight map to glide; explicit flapping maps to flap. Threats point from the named threat to the named hero. Negated actions are omitted from essential triples; negated contains the excluded canonical verbs. A negation of stopping keeps the positive action. Unknown actions retain their base verb and explicit object.

The seal records the SHA-256 of the exact UTF-8 sentence file bytes and category counts. A mechanical lowercase/punctuation/whitespace normalized overlap check against all groups in P30, P41, P42 and rounds 2?4 found zero overlaps. Only overlap counts were exposed to the author. The sentence file must remain frozen after any implementation sees it; future tuning requires a fresh held-out cohort.

Final runner preserves the previous statistical protocol and limits. It writes an exclusive started.json marker and immutable checkpoints/row-001.json through row-320.json, followed by final.json/final.md and golden.log only once. I/O retry handles UNKNOWN/EBUSY/EPERM/EACCES without recomputing observations. Run only after source freeze with P42_ROUND5_FINAL_OPEN_HELD_OUT=1 and vitest.measure.mts. No results are read during execution. New test data must not be viewed before this run.
