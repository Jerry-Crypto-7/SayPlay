# P56C T8 – řetěz, nebo jedna hra (dev)

Změřeno 2026-10-21 `decide.measure.ts`, čtení slovníkem, `classifyGenre(věta, null)`. Práh náskoku obecné buňky `GENERIC_MARGIN` = 3: na dev leží mezi „a goth teenage ghost with a skateboard“ (`runner.default`, náskok 2 → řetěz) a „steer a hot air balloon…“, „catch snowflakes…“, „herd the runaway sheep…“ (obecná buňka, náskok 4 → jedna hra). Platí každá hodnota 3–4; zapečetěná sada ho potvrdí nebo vyvrátí.

| Rodina | AC | Výsledek |
|---|---|---|
| `multi_verb` → řetěz | ≥ 10/12 | 11/12 |
| `no_verb` + `world_only` → řetěz | ≥ 15/18 | 18/18 |
| `single_verb` → jedna hra | ≥ 8/10 | 10/10 |

| id | rodina | rozhodnutí | větve | první buňka |
|---|---|---|---|---|
| d01 | multi_verb | řetěz | multi_verb | throw.default 5 (náskok 2) |
| d02 | multi_verb | řetěz | multi_verb | platformer.default 6 (náskok 3) |
| d03 | multi_verb | jedna hra | – | quest.station 4 (náskok 4) |
| d04 | multi_verb | řetěz | multi_verb | platformer.default 5 (náskok 3) |
| d05 | multi_verb | řetěz | cue | catch.default 4 (náskok 2) |
| d06 | multi_verb | řetěz | multi_verb | voyage.race 6 (náskok 5) |
| d07 | multi_verb | řetěz | multi_verb, generic | voyage.race 4 (náskok 2) |
| d08 | multi_verb | řetěz | multi_verb | platformer.default 6 (náskok 4) |
| d09 | multi_verb | řetěz | multi_verb, cue | quest.spatial 4 (náskok 2) |
| d10 | multi_verb | řetěz | multi_verb | voyage.race 6 (náskok 4) |
| d11 | multi_verb | řetěz | multi_verb | throw.default 5 (náskok 3) |
| d12 | multi_verb | řetěz | multi_verb | throw.default 5 (náskok 4) |
| d13 | single_verb | jedna hra | – | quest.spatial 4 (náskok 4) |
| d14 | single_verb | jedna hra | – | rhythm.default 3 (náskok 3) |
| d15 | single_verb | jedna hra | – | slice.default 4 (náskok 2) |
| d16 | single_verb | jedna hra | – | whack.default 4 (náskok 3) |
| d17 | single_verb | jedna hra | – | throw.default 8 (náskok 7) |
| d18 | single_verb | jedna hra | – | voyage.race 4 (náskok 4) |
| d19 | single_verb | jedna hra | – | arena.collect 5 (náskok 4) |
| d20 | single_verb | jedna hra | – | quest.spatial 4 (náskok 4) |
| d21 | single_verb | jedna hra | – | arena.collect 4 (náskok 4) |
| d22 | single_verb | jedna hra | – | platformer.default 4 (náskok 4) |
| d23 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d24 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d25 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d26 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d27 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d28 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d29 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d30 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d31 | no_verb | řetěz | generic | runner.default 2 (náskok 2) |
| d32 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d33 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d34 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d35 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d36 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d37 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d38 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d39 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d40 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |

