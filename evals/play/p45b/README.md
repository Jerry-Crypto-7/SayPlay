# P45B – jazyk pravidel v2: měření

## Měřidlo podílu logiky (`logic-share.ts`)

Pro každou větu spustí okamžitý návrh (`draftGameSpecWithMeta`, semínko 1, bez modelu), změří čas
návrhu a hru ověří (`verifyArcade`). Hra **používá logiku**, jen když spec deklaruje blok `logic`,
aspoň jedno pravidlo má logický spouštěč, podmínku nebo efekt **a** robot ji dohraje. Čte jen
vývojové sady; testovací a zapečetěné sady odmítne (`openSet`, test `__tests__/logic-share.test.ts`).

```
npx vitest run --config vitest.measure.mts evals/play/p45b/logic-share.measure.ts
P45B_OUT=evals/play/p45b/dev.json npx vitest run --config vitest.measure.mts evals/play/p45b/logic-share.measure.ts
```

`P45B_SET` (čárkou oddělené cesty) vymění sady, `P45B_OUT` výstupní soubor.

## Baseline (`baseline.json`, `main` `0714a352`, 8. 10.)

Sady `p30/dev.json` (60) + `p37a/dev-150.json` (150) = 210 vět.

| | |
|---|---|
| hratelné | 210/210 (100 %) |
| používá logiku | 0 (0 %) |
| p50 návrhu | 202 ms |
| p95 návrhu | 509 ms |

Strop pro T9: p95 ≤ 2000 ms a ne horší než 509 × 1,25 = **636 ms**. Časy jsou z jednoho běhu na
vývojovém stroji; srovnávat jen běhy pouštěné samotné (bez buildu a agentů na pozadí).

## T9 – šablony v okamžitém návrhu (`dev.json`)

Stejné sady jako baseline. `compileRecipe` připojí šablonu jen receptu ze `assemble` (nese slova
věty a nehraná slovesa); režisér, buňky a měřidla záměr nenesou a šablonu nedostanou. Nejdřív
`goal` šablona slovesa, které žánr nehraje, jinak `overlay` podle os receptu a slov věty; sloty
berou role hry. `compose` zkusí hru se šablonou, pak tentýž recept bez ní, teprve potom ubere díl.

| | baseline | T9 | cíl |
|---|---|---|---|
| používá logiku | 0 % | **54,8 %** (115/210) | ≥ 40 % |
| hratelné | 210/210 | 210/210 | 100 % |
| p50 návrhu | 202 ms | 247 ms | – |
| p95 návrhu | 509 ms | **497 ms** | ≤ 636 ms |

`dev.json` je změřený nad stromem commitu T9 (pole `commit` ukazuje na jeho rodiče; kód se po
měření neměnil, jen testy).

Šablony: `treasure_rush` 44 (sbírací arény), `reinforcements` 43 (úkoly 23 + útěkové arény 20),
`coin_shower` 28 (tratě: auto 12, běžec 11, plošinovka 3, mávání 2). Konstrukce: fáze a vlna 115,
časovač 72; proměnná a událost 0 – ty nesou `goal` šablony, které okamžitý návrh na dev sadách
nevybral (žánry jejich slovesa hrají).

- **Kde šablona padá a hra jde bez ní:** let (`glide`) s `coin_shower` – robot prohraje (d12,
  u57, f12); vlna `edge` na trati/v bludišti/na plošinovce (s006, j04, d14, m16, d20) – odmítne
  už kompilace, stojí jen ji.
- **p95:** první běh 932 ms – útěkové arény s lovci po vlnách `waves_survive` padaly 9× z 20
  (dvojí ověření ~800 ms). `reinforcements` (jedna hlídka po 10 s) dostala osu
  `objective:survive` a stojí před `waves_survive`: projde všech 20. Měřeno při zatížení CPU ~50 %
  jinými relacemi; nezatížené buňky bez šablony byly o 15–25 % pomalejší než v baseline.
- **Další páka, kdyby p95 rostlo:** tratě s `coin_shower` jsou o 10–20 % pomalejší než bez
  šablony – vlna si rezervuje `RULE_SPAWN_SLOTS` (8) mrtvých těl navíc i bez efektu `spawn`
  (`rules/compile.ts:782`). Nezměněno (mimo soubory T9).

**Bez regrese:**

- **Hloubka** (`p36/depth.measure.ts` + `depth.test.ts`): zelené – v pásmu 30–90 s 234/260
  (0,90 ≥ 0,85), nečinný hráč prohraje 260/260, víc životů 0,881 ≥ 0,8. Commitnutý `depth.json`
  je z 2. 10., před ovládáním P44: rozdíly nesou nové generátory z `main` (`control:glide`,
  `walker`, `ball`, `move_free` – let končí v 15,12 s u čtyř vět), žádný řádek mimo pásmo nemá
  šablonu. Závěr se nezměnil, soubor vrácen.
- **Obtížnost** (`p41/difficulty.measure.ts`): buňky jdou přes `assemblyOfCell` bez záměru, takže
  šablonu nedostanou – `difficulty.json` se přepsal bajt po bajtu stejně (novice i intermediate
  beze změny, rozdíl 0).
- **Golden P41** a replay brána zelené – golden matice jde mimo `compose`.
