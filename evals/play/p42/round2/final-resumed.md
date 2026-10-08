# P42 round2 resumed measurement

Operational recovery after a checkpoint write failure. Original final.json is preserved. The first 47 rows and their latencies are unchanged; a possible unpersisted 48th attempt is unknown. This is not a complete uninterrupted one-shot run.

FAIL

- planned: 320
- measured: 320
- preservedSentences: 51
- preservedSentenceAllSeedsRate: 0.796875
- preservedRunRate: 0.83125
- buildRate: 1
- heroRate: 0.9782608695652174
- heroApplicable: 230
- environmentRate: 0.8
- environmentApplicable: 150
- silentTriples: 20
- p95ms: 1562.3822999999975
- golden: true

Failures and all witnesses: final-resumed.json. Golden log: golden-resumed.log. Human play is a separate required check; this report does not claim it occurred.
