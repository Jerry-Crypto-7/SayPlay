# P56C T7 / T16 – řetěz na dev sadě (s mutátory)

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

Délka řetězu (semínko publikace): min 30.0 s, medián 33.3 s, max 38.0 s. Stavba + ověření jednoho řetězu: medián 923 ms, max 4638 ms (stroj není v klidu, orientační).

Mutátory (T16, `CHAIN_MUTATORS`): 360/360 kol 2 až N−1 nese mutátor (semínko publikace 120/120); kolo bez něj = žádný mutátor z `mutator-compat.json` na rozložení kola neprošel robotem, nečinným nebo délkou.

Stavitel bere jen kola, která robot vyhraje a nečinný prohraje (až 4 semínka na kolo, pak jiná mikrohra), a řetěz pod 30 s doplní výměnou nejkratšího kola za delší – proto minimum délky leží těsně na prahu.

## Věty (semínko publikace)

| id | rodina | kola | ovládání | s | chyby |
|---|---|---|---|---|---|
| d01 | multi_verb | runner.default → hop.default + tiny_hero → crowd.default + mirror → timing.precision + vanishing_floor → defense.default.boss | 5 | 32.6 | – |
| d02 | multi_verb | catch.default → runner.default + shield_start → flap.default + shield_start → rhythm.default + mirror → duel.default.boss | 5 | 33.8 | – |
| d03 | multi_verb | timing.stack → duel.default + hero_grows → platformer.default + double_speed → shooter.default + double_speed → defense.default.boss | 5 | 30.9 | – |
| d04 | multi_verb | platformer.default → timing.stack + shield_start → defense.default + extra_foes → duel.default + vanishing_floor → shooter.default.boss | 5 | 30.8 | – |
| d05 | multi_verb | catch.default → platformer.default + tiny_hero → duel.default + giant_foes → rhythm.default + vanishing_floor → shooter.default.boss | 5 | 37.5 | – |
| d06 | multi_verb | runner.default → crowd.default + one_hit → catch.default + giant_foes → platformer.default + hero_grows → shooter.default.boss | 5 | 36.4 | – |
| d07 | multi_verb | runner.default → crowd.default + tiny_hero → hop.default + tiny_hero → flap.default + tiny_hero → defense.default.boss | 5 | 31.9 | – |
| d08 | multi_verb | platformer.default → catch.default + mirror → runner.default + hero_grows → crowd.default + shield_start → shooter.default.boss | 5 | 36.7 | – |
| d09 | multi_verb | whack.default → timing.stack + shield_start → rhythm.default + double_speed → runner.default + tiny_hero → shooter.default.boss | 5 | 31.8 | – |
| d10 | multi_verb | runner.default → crowd.default + shield_start → platformer.default + tiny_hero → catch.default + giant_foes → shooter.default.boss | 5 | 32.9 | – |
| d11 | multi_verb | shooter.default → whack.default + mirror → platformer.default + double_speed → rhythm.default + hero_grows → duel.default.boss | 5 | 35.2 | – |
| d12 | multi_verb | runner.default → crowd.default + tiny_hero → whack.default + one_hit → timing.stack + vanishing_floor → shooter.default.boss | 5 | 32.0 | – |
| d13 | single_verb | catch.default → platformer.default + hero_grows → flap.default + rush → hop.default + tiny_hero → shooter.default.boss | 5 | 32.0 | – |
| d14 | single_verb | catch.default → flap.default + tiny_hero → runner.default + tiny_hero → rhythm.default + shield_start → shooter.default.boss | 5 | 32.2 | – |
| d15 | single_verb | flap.default → hop.default + shield_start → catch.default + tiny_hero → duel.default + vanishing_floor → shooter.default.boss | 5 | 36.3 | – |
| d16 | single_verb | whack.default → timing.stack + giant_foes → crowd.default + giant_foes → platformer.default + shield_start → duel.default.boss | 5 | 30.5 | – |
| d17 | single_verb | shooter.default → duel.default + shield_start → platformer.default + giant_foes → timing.precision + vanishing_floor → defense.default.boss | 5 | 33.4 | – |
| d18 | single_verb | runner.default → crowd.default + tiny_hero → whack.default + vanishing_floor → rhythm.default + tiny_hero → duel.default.boss | 5 | 32.4 | – |
| d19 | single_verb | catch.default → platformer.default + double_speed → runner.default + shield_start → hop.default + shield_start → shooter.default.boss | 5 | 34.5 | – |
| d20 | single_verb | whack.default → timing.stack + tiny_hero → rhythm.default + double_speed → hop.default + shield_start → duel.default.boss | 5 | 35.3 | – |
| d21 | single_verb | whack.default → timing.precision + hero_grows → duel.default + vanishing_floor → runner.default + shield_start → shooter.default.boss | 5 | 33.8 | – |
| d22 | single_verb | platformer.default → catch.default + hero_grows → flap.default + shield_start → timing.stack + vanishing_floor → duel.default.boss | 5 | 36.9 | – |
| d23 | no_verb | timing.stack → runner.default + one_hit → whack.default + tiny_hero → platformer.default + shield_start → shooter.default.boss | 5 | 31.6 | – |
| d24 | no_verb | defense.default → flap.default + rush → rhythm.default + mirror → runner.default + one_hit → shooter.default.boss | 5 | 31.9 | – |
| d25 | no_verb | catch.default → timing.stack + vanishing_floor → duel.default + giant_foes → runner.default + mirror → shooter.default.boss | 5 | 34.1 | – |
| d26 | no_verb | catch.default → timing.stack + hero_grows → flap.default + rush → runner.default + one_hit → duel.default.boss | 5 | 32.0 | – |
| d27 | no_verb | whack.default → runner.default + rush → duel.default + hero_grows → rhythm.default + shield_start → shooter.default.boss | 5 | 33.3 | – |
| d28 | no_verb | crowd.default → rhythm.default + mirror → hop.default + vanishing_floor → timing.stack + tiny_hero → defense.default.boss | 5 | 31.5 | – |
| d29 | no_verb | hop.default → runner.default + hero_grows → platformer.default + mirror → timing.precision + hero_grows → defense.default.boss | 5 | 34.8 | – |
| d30 | no_verb | duel.default → flap.default + shield_start → runner.default + tiny_hero → defense.default + giant_foes → shooter.default.boss | 5 | 33.8 | – |
| d31 | no_verb | runner.default → hop.default + vanishing_floor → whack.default + vanishing_floor → platformer.default + tiny_hero → duel.default.boss | 5 | 36.1 | – |
| d32 | no_verb | hop.default → rhythm.default + hero_grows → timing.stack + tiny_hero → platformer.default + mirror → defense.default.boss | 5 | 38.0 | – |
| d33 | world_only | flap.default → catch.default + hero_grows → rhythm.default + tiny_hero → timing.stack + shield_start → shooter.default.boss | 5 | 33.2 | – |
| d34 | world_only | catch.default → runner.default + shield_start → duel.default + vanishing_floor → hop.default + tiny_hero → shooter.default.boss | 5 | 35.4 | – |
| d35 | world_only | timing.stack → runner.default + hero_grows → duel.default + shield_start → platformer.default + double_speed → defense.default.boss | 5 | 31.9 | – |
| d36 | world_only | runner.default → crowd.default + giant_foes → shooter.default + vanishing_floor → duel.default + tiny_hero → defense.default.boss | 5 | 30.3 | – |
| d37 | world_only | shooter.default → timing.precision + shield_start → duel.default + vanishing_floor → platformer.default + giant_foes → defense.default.boss | 5 | 30.0 | – |
| d38 | world_only | whack.default → runner.default + mirror → shooter.default + giant_foes → rhythm.default + hero_grows → duel.default.boss | 5 | 31.6 | – |
| d39 | world_only | platformer.default → hop.default + shield_start → runner.default + hero_grows → timing.precision + shield_start → shooter.default.boss | 5 | 36.5 | – |
| d40 | world_only | runner.default → hop.default + tiny_hero → catch.default + mirror → timing.precision + tiny_hero → shooter.default.boss | 5 | 34.5 | – |

