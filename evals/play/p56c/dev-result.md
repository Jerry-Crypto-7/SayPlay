# P56C T7 – řetěz na dev sadě

Změřeno 2026-10-21 `dev.measure.ts`: 40 vět vynuceně jako řetěz, čtení slovníkem (`readForChain(text, null)`), semínko `seedFrom(věta)` jako publikace; odolnost na dvou dalších semínkách z `derivedSeeds`.

| Kontrola | AC | Semínko publikace | + 2 semínka |
|---|---|---|---|
| `verifyChain` bez chyby | 40/40 | 40/40 | 120/120 |
| ≥ 3 různá ovládání | ≥ 34/40 | 40/40 | 120/120 |
| délka 30–90 s | 40/40 | 40/40 | 120/120 |
| jeden `theme.look` ve všech kolech | 40/40 | 40/40 | 120/120 |
| jeden popisek hrdiny ve všech kolech | 40/40 | 40/40 | 120/120 |
| kolo 1 = hlavní sloveso (věty se slovesem z `VERB_MICROS`) | všechny | 21/21 | 63/63 |
| boss nese protivníka věty (věty s protivníkem) | všechny | 6/6 | 18/18 |

Délka řetězu (semínko publikace): min 30.0 s, medián 33.5 s, max 38.0 s. Stavba + ověření jednoho řetězu: medián 269 ms, max 1225 ms (stroj není v klidu, orientační).

Stavitel bere jen kola, která robot vyhraje a nečinný prohraje (až 4 semínka na kolo, pak jiná mikrohra), a řetěz pod 30 s doplní výměnou nejkratšího kola za delší – proto minimum délky leží těsně na prahu.

## Věty (semínko publikace)

| id | rodina | kola | ovládání | s | chyby |
|---|---|---|---|---|---|
| d01 | multi_verb | runner.default → hop.default → crowd.default → timing.precision → defense.default.boss | 5 | 32.6 | – |
| d02 | multi_verb | catch.default → runner.default → flap.default → rhythm.default → duel.default.boss | 5 | 33.8 | – |
| d03 | multi_verb | timing.stack → duel.default → platformer.default → shooter.default → defense.default.boss | 5 | 31.2 | – |
| d04 | multi_verb | platformer.default → timing.stack → defense.default → duel.default → shooter.default.boss | 5 | 31.2 | – |
| d05 | multi_verb | catch.default → platformer.default → duel.default → rhythm.default → shooter.default.boss | 5 | 37.3 | – |
| d06 | multi_verb | runner.default → crowd.default → catch.default → platformer.default → shooter.default.boss | 5 | 36.4 | – |
| d07 | multi_verb | runner.default → crowd.default → hop.default → flap.default → defense.default.boss | 5 | 31.9 | – |
| d08 | multi_verb | platformer.default → catch.default → runner.default → crowd.default → shooter.default.boss | 5 | 36.7 | – |
| d09 | multi_verb | whack.default → timing.stack → rhythm.default → runner.default → shooter.default.boss | 5 | 31.8 | – |
| d10 | multi_verb | runner.default → crowd.default → platformer.default → catch.default → shooter.default.boss | 5 | 32.9 | – |
| d11 | multi_verb | shooter.default → whack.default → platformer.default → rhythm.default → duel.default.boss | 5 | 35.2 | – |
| d12 | multi_verb | runner.default → crowd.default → whack.default → timing.stack → shooter.default.boss | 5 | 32.0 | – |
| d13 | single_verb | catch.default → platformer.default → flap.default → hop.default → shooter.default.boss | 5 | 33.4 | – |
| d14 | single_verb | catch.default → flap.default → runner.default → rhythm.default → shooter.default.boss | 5 | 32.2 | – |
| d15 | single_verb | flap.default → hop.default → catch.default → duel.default → shooter.default.boss | 5 | 36.3 | – |
| d16 | single_verb | whack.default → timing.stack → crowd.default → platformer.default → duel.default.boss | 5 | 30.5 | – |
| d17 | single_verb | shooter.default → duel.default → platformer.default → timing.precision → defense.default.boss | 5 | 33.5 | – |
| d18 | single_verb | runner.default → crowd.default → whack.default → rhythm.default → duel.default.boss | 5 | 32.4 | – |
| d19 | single_verb | catch.default → platformer.default → runner.default → hop.default → shooter.default.boss | 5 | 34.5 | – |
| d20 | single_verb | whack.default → timing.stack → rhythm.default → hop.default → duel.default.boss | 5 | 35.3 | – |
| d21 | single_verb | whack.default → timing.precision → duel.default → runner.default → shooter.default.boss | 5 | 33.8 | – |
| d22 | single_verb | platformer.default → catch.default → flap.default → timing.stack → duel.default.boss | 5 | 36.9 | – |
| d23 | no_verb | timing.stack → runner.default → whack.default → platformer.default → shooter.default.boss | 5 | 31.6 | – |
| d24 | no_verb | defense.default → flap.default → rhythm.default → runner.default → shooter.default.boss | 5 | 33.0 | – |
| d25 | no_verb | catch.default → timing.stack → duel.default → runner.default → shooter.default.boss | 5 | 34.1 | – |
| d26 | no_verb | catch.default → timing.stack → flap.default → runner.default → duel.default.boss | 5 | 33.1 | – |
| d27 | no_verb | whack.default → runner.default → duel.default → rhythm.default → shooter.default.boss | 5 | 34.5 | – |
| d28 | no_verb | crowd.default → rhythm.default → hop.default → timing.stack → defense.default.boss | 5 | 31.5 | – |
| d29 | no_verb | hop.default → runner.default → platformer.default → timing.precision → defense.default.boss | 5 | 34.8 | – |
| d30 | no_verb | duel.default → flap.default → runner.default → defense.default → shooter.default.boss | 5 | 33.8 | – |
| d31 | no_verb | runner.default → hop.default → whack.default → platformer.default → duel.default.boss | 5 | 36.1 | – |
| d32 | no_verb | hop.default → rhythm.default → timing.stack → platformer.default → defense.default.boss | 5 | 38.0 | – |
| d33 | world_only | flap.default → catch.default → rhythm.default → timing.stack → shooter.default.boss | 5 | 33.2 | – |
| d34 | world_only | catch.default → runner.default → duel.default → hop.default → shooter.default.boss | 5 | 35.4 | – |
| d35 | world_only | timing.stack → runner.default → duel.default → platformer.default → defense.default.boss | 5 | 31.9 | – |
| d36 | world_only | runner.default → crowd.default → shooter.default → duel.default → defense.default.boss | 5 | 30.3 | – |
| d37 | world_only | shooter.default → timing.precision → duel.default → platformer.default → defense.default.boss | 5 | 30.0 | – |
| d38 | world_only | whack.default → runner.default → shooter.default → rhythm.default → duel.default.boss | 5 | 31.6 | – |
| d39 | world_only | platformer.default → hop.default → runner.default → timing.precision → shooter.default.boss | 5 | 36.5 | – |
| d40 | world_only | runner.default → hop.default → catch.default → timing.precision → shooter.default.boss | 5 | 34.5 | – |

