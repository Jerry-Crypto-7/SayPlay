# P42 round4 resumed measurement

Operational recovery after a checkpoint write failure. Original final.json is preserved. The first 187 rows and their latencies are unchanged; a possible unpersisted 188th attempt is unknown. This is not a complete uninterrupted one-shot run.

FAIL

- planned: 320
- measured: 320
- preservedSentences: 39
- preservedSentenceAllSeedsRate: 0.609375
- preservedRunRate: 0.621875
- buildRate: 1
- heroRate: 0.875
- heroApplicable: 320
- environmentRate: 0.875
- environmentApplicable: 320
- silentTriples: 140
- p95ms: 3313.830900000001
- golden: true

Failures and all witnesses: final-resumed.json. Golden log: golden-resumed.log. Human play is a separate required check; this report does not claim it occurred.
