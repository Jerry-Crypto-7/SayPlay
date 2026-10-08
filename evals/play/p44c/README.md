# P44C – otevřený slovník

Neznámé sloveso nebo podstatné jméno z věty dopadne offline tabulkou (Open English WordNet 2024 +
embeddingy) na existující mechaniku a model. Runtime jen čte mapu; `PLAY_VOCAB=off` vrací chování před P44C.

## Výchozí čísla (T1)

`baseline.json` z `baseline.measure.ts` nad `main` `434cc051` (P42 sloučený squashem v PR #26 – proto se P42
v `main` ověřuje obsahem `src/play/compose/`, ne předkem `65e449d5`, který squash do historie `main` nepřenesl).

| Sada | Vět | Výsledek |
|---|---|---|
| P42 vývojová (`p42/round5` → `held-out`) | 64 | zachováno 59 (`scoreTriples`) |
| `p37a/dev-150` | 150 | sloveso přečtené 104 |
| `p30/dev` | 60 | sloveso přečtené 44 |

Každý řádek nese i `intent` z `extractIntent` – proti němu T7 porovná `PLAY_VOCAB=off`.
`P44C_AFTER=1` týmž měřidlem zapíše `after-dev.json` (T13).

## Zapečetěná sada (T2)

`sealed-110.json` – 114 vět od nezávislého podagenta (55 `unknown-verb`, 32 `fantasy`, 15 `non-game`,
12 `control`), napsaná dřív, než existuje kód P44C. Podagent napsal 115; `s44c-089` se po normalizaci shodovala
s větou otevřené sady, a tak byla vyřazená podle id, bez čtení textu. SHA-256 nad LF bajty:
`1113be1ad14359e07febd1d397e6a8aa3131e01e05f3ebfe4a0ef23f57a39e4a` (`dataset-seal.json`).
Čte ji jen `open-sealed.ts` s `--open-sealed-once`, jednou (T14).

## Kotvy a zlatá sada (T3)

`src/play/vocab/anchors.ts`: 41 cílů (8 pohybů, 11 akcí, 10 cílů hry, 12 póz hrdiny) s kotevními slovesy a synsety
OEWN 2024. Test je ověří proti ruční tabulce `ROWS` – žádná kotva neříká nic jiného než návrh.
`src/play/vocab/__fixtures__/gold-verbs.json`: 266 párů sloveso → cíl (70 záporných) od nezávislého podagenta;
47 párů vyřadil skript bez čtení slov, protože jejich tvar je ve slovech `said` zapečetěné sady (36) nebo jen v test-200 (11).

## Volba metody (T4)

`node scripts/vocab/fetch-oewn.mjs` ověří SHA archivu a licenci, kterou vydání samo deklaruje
(`<Lexicon license="https://creativecommons.org/licenses/by/4.0">`; zip vydání soubor LICENSE nemá).
`node scripts/vocab/build.mjs --evaluate` (s `P37A_PYTHON`) změří tři metody na zlaté sadě → `method.json`.

| Varianta | Nejlepší nastavení | Přesnost | Pokrytí | Falešně namapované záporné |
|---|---|---|---|---|
| A – cesta hyperonym WordNetu ke kotvě | práh 0,4 | 90,2 % | 37,8 % | 0 |
| B – embedding MiniLM „to <verb>“ | práh 0,75 | 92,7 % | 19,4 % | 0 |
| C – A, jinak B | 0,4 / 0,8 | 90,2 % | 37,8 % (B nic nepřidá) | 0 |

**Vybraná A @ 0,4** (`scripts/vocab/config.json` → `method`). Embedding bránu 90 % splní jen s prahem,
kde pokryje polovinu toho co WordNet; pod ním plete téma se slovesem (B @ 0,5: přesnost 52 %, 5 falešných).

Jak se k tomu došlo (vše na zlaté sadě, ne na zapečetěné): první měření dalo A 82,6 % – kotva „strike“ (úder)
táhla k rvačce i „tap“ a „rap“, a „withstand“ / „weather“ vedly přes „resist“ k rvačce. Kotva „strike“ šla pryč
a dva synsety „resist“ (odolat náporu) patří k přežití. Zkoušené a zahozené: silnější váha hlavního významu
(1/(pořadí+1)²), skóre jako podíl mezi kotvenými významy, povinná kotva hlavního významu – nic nedalo víc
pokrytí při bráně a „stab“ pak propadl.

Zbylých 8 chyb A (`method.json` → `selectedErrors`): `accumulate` (zlatá sada chce `objective:collect`,
metoda dá `action:collect` – cíl „sebrat všechno“ dává až slovo „all“), `strafe` a `torpedo` (útok zbraní
je ve WordNetu pod „attack“, takže rvačka místo střelby), `harpoon` (chytání místo střelby), `darn` (oprava
místo pletení), `outpace` (porazit místo závodu), `raft` (doprava místo jízdy), `shovel` (zlatá sada chce
kopání, ruční tabulka rodin hry ho bere jako úklid – kotva drží ruční tabulku).
