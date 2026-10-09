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

## T11 – režisér s logikou na gpt-oss-20b (`director-logic.json`) – cíl nesplněn

25 vět `director-sentences.json` (pravidlo výběru v souboru): braň s155 h03 j08 · zachraň d20 u47
m10 · poraz s188 f22 si-031 ma-031 · přežij si-018 ma-048 pa-017 pa-018 · uteč s003 s008 h09 j10 ·
závod s056 s058 h02 d06 · sbírej s002 j05 d16.

```
node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p45b/director-logic.cmd
npx vitest run src/play/director/__tests__/logic-fixtures.test.ts
```

Kompaktní režisér jako v produktu (effort low, 4 000 tokenů, 120 s), **jen první odpověď, bez
opravného kola**; soudí `judgeLogicAnswer` (`src/play/director/__fixtures__/logic-answers.ts`)
cestou produktu – `direct()` včetně opravy vstupu do fáze (níže).

| běh (9. 10.) | prompt | deklaruje logiku | projde |
|---|---|---|---|
| 1 | T10 | 1/23 (2× výpadek spojení) | 0/25 |
| 2 | + „logic – REQUIRED…“ v systémovém promptu | 2/25 | 0/25 |
| 3 | + řádek `COURSE_LINE` na konci zprávy k větě | **23/25** | **0/25** |

Próza v systémovém promptu model skoro nehne, řádek ve zprávě ano. Plán dovolil dvě opravy
promptu; obě vyčerpané.

**Oprava vstupu do fáze (rozhodnutí 9. 10., varianta a).** Čtení odpovědi režiséra
(`readGenreAnswer` i `readRecipeAnswer` v `src/play/director/read.ts`) volá `withPhaseEntries`
(`src/play/arcade/rules/schema.ts`): fáze, na kterou pravidlo reaguje (`when.phase`,
`when.phaseExit`, `if.inPhase`) a nic do ní nepřepne, dostane pravidlo `enter_<fáze>` – každých
240 tiků z fáze před ní (jako `LOGIC EXAMPLE` promptu), sloveso `advance`. Fázi, kterou nikdo nečte,
nechá být. Prompt se neměnil, záznam 3 platí, nový záznam nebyl.

| soud záznamu 3 | projde |
|---|---|
| `raw` – bez opravy | **0/25** |
| `repaired` – cesta produktu s opravou | **0/25** |
| odpovědí, kterým oprava něco doplnila | 0/25 |

```
set P45B_JUDGE_ONLY=1 && npx vitest run --config vitest.measure.mts evals/play/p45b/director-logic.measure.ts
```

**Proč padá – fakta ze záznamů** (statický rozbor odpovědí, jedna odpověď může mít víc příčin):

| příčina | odpovědí |
|---|---|
| deklaruje fázi za první, kterou žádné pravidlo nečte ani do ní nepřepne | **23 z 23** s logikou |
| pravidlo, které na fázi reaguje – tvar, na který míří oprava | **0** |
| deklaruje časovač, který žádné pravidlo nespustí | 13 |
| spouští časovač `every: N` kratším než jeho délka – obnoví se dřív, než doběhne | 6 |
| podmínka s `atLeast` i `below` zároveň | 5 |
| bez logiky | 2 (s188, si-031) |

Dřívější popis („deklaruje fázi, na kterou pravidlo reaguje“) byl chybný: žádná odpověď na fázi
nereaguje. Model opíše kostru „fáze + časovač“ z řádku `Course:` a příkladu, ale nepropojí ji
s pravidly.

**Odhad, ne měření:** ani zahození mrtvých deklarací fází by na 20/25 nestačilo – bez jiné statické
vady zůstávají jen h02 a s008. Páky, které by číslo hnuly, míří na model, ne na čtení: soud až po
opravných kolech produktu (ta chybějící `goPhase`/`startTimer` jmenují), nebo příklad, kde každá
deklarace má pravidlo, které ji spustí, i pravidlo, které na ni reaguje. Cíl ≥ 20/25 je nesplněný;
`logic-fixtures.test.ts` drží zapsané číslo (každá fixtura `raw` i `repaired` jako
v `director-logic.json`).

## T12 – po sloučení `origin/main` (9. 10.)

Sloučen `main` `fc6b99ba` (P45A #30 měřidlo zábavy, P45E #31 modely) bez konfliktu – žádný soubor
nezměnily obě strany. `tsc` čisté.

**Celá sada** (`npx vitest run`, 21 min): 12 464 testů, 32 červených ve 21 souborech. Stroj byl celou
dobu na 100 % CPU od cizí práce (antivir, procesy jiných relací), sada tedy neběžela „v klidu“.

| skupina | testů | co s tím |
|---|---|---|
| skutečná chyba P45B: `p30-sets` – skript čte `verify.ts` přes odstranění typů v Node, které neumí vlastnost v parametru konstruktoru (T7) | 1 | opraveno `7728a189` |
| skutečná chyba P45B: `anchors` – vyhledávací slovesa šablon T9 (`infiltrate`, `scavenge`, `sprint`) katalog kotev nezná | 1 | opraveno `75e6957f` → `tiptoe`, `munch`, `surf` (kotvená, v žádné sadě vět nejsou, pokrytí ani `dev.json` se nehnou) |
| prostředí worktree: ENOENT `plans/P8-odevzdani.md` (`submission-check`) | 1 | gitignorovaný soubor |
| pod zátěží (časové meze, souběh procesů) – soubory zvlášť zelené | 27 | – |
| časové meze pod zátěží – červené i zvlášť | 2 | stejně červené na čistém `main` (níže) |

Dva zbylé testy pustil i dočasný worktree `origin/main` při stejné zátěži:

| test | `main` | P45B |
|---|---|---|
| `scenery-carve` (mez 30 s; kód P45B nemění) | 46,3 s ✗ | 32,5–35,8 s ✗ |
| `upgrade` „návrh pod 3 s“ | 4,2 / 3,7 s ✗ | 5,7 / 5,5 s ✗ |

**Fakt:** P45B je u `upgrade` o ~1,5 s pomalejší. Rozklad stejnou větou („A hamster escapes…“):
první návrh nové věty `main` 1,6–2,0 s, P45B 2,6 s – šablona `coin_shower` projde ověřením napoprvé,
ale svět s logikou a vlnou se ověřuje déle; věta, které šablona vypadne (rytíř a netopýři), stojí
na obou stranách stejně (1,2–1,5 s). Opakovaný návrh téže věty 4–24 ms na obou stranách.
**Odhad:** v klidu (T9: p50 247 ms, p95 497 ms) se strop 3 s nepřekročí; ověřit sadou v klidu před
pushem.

**E2E** (build `npm run build`, `next start -p 3217`, `FALLBACK_SMOKE_URL`): všech 10 souborů zelených
– 50 testů napoprvé, zbylých 10 (`play-rules`, `play-physics-*`, `play-composed-actions`) po
restartu serveru s `PLAY_LAB=1`, který jejich laboratorní stránky potřebují (bez něj 404).

**Brány nad sloučeným stavem:** replay brána 116/116 (+ `kernel-logic` 12 = dřívějších 128), hloubka
zelená beze změny proti T9 (v pásmu 234/260 = 0,90, nečinný prohraje 260/260, víc životů 0,881;
`depth.json` vrácen), obtížnost – `difficulty.json` bajtově stejný. Hranice plánu prázdné.

## T12a – příklad, kde každá fáze a časovač mají spouštěč i čtenáře (9. 10.) – cíl nesplněn

Stejný příkaz a soud jako T11. `director-logic.json` nese nový soud (`raw`, `repaired`) a vedle něj
čísla záznamu 3 z T11 (`before`).

| záznam (9. 10.) | prompt | deklaruje logiku | `raw` | `repaired` |
|---|---|---|---|---|
| 3 (T11) | příklad T10 (přežití: `every` přepne do roje, výhra na časovači) + `Course:` z T11 | 23/25 | 0/25 | 0/25 |
| 4 | nový `LOGIC EXAMPLE` + věta pravidla v systémovém promptu | 25/25 | 1/25 (ma-048) | 1/25 |
| 5 | + řádek `Course:` popisuje celé zapojení a zakazuje výhru/prohru na časovači a fázi | 24/25 | **1/25** (s008) | **1/25** |

**Nový příklad** (`prompt.ts`): fáze `day` vstoupí v tiku 0 → `sunset` spustí časovač `dusk` jednou →
`fall` na doběhnutí přepne do `night` → `swarm` na vstup do noci pustí jednoho netopýra od okraje.
Vlastní výhru nemá – cíl drží žánr. Test `logic-answer-schema.test.ts` pouští příklad přes `direct()`
a robota: projde bez opravného kola s prokázanou fází, časovačem i vlnou. Vlna pronásledovatele
v Aréně je citlivá na čas: noc po 300, 480 a 600 tikách robot prohraje (netopýr ho chytí), po 180,
900 a 1 200 vyhraje – příklad má 900. Fixtury a soud jsou záznam 5 (hash dnešního promptu).

**Co řádek `Course:` hnul** (statický rozbor odpovědí, jedna odpověď může mít víc příčin):

| zapojení | záznam 4 | záznam 5 |
|---|---|---|
| pozdější fáze, do které žádné pravidlo nepřepne (`goPhase`) | 23 | **18** |
| výhra nebo prohra na časovači | 11 | **1** |
| výhra nebo prohra na vstupu do fáze | 0 | 3 |
| pravidlo na doběhnutí časovače přepne fázi (vzor příkladu) | 2 | **6** |
| časovač, který nic nespustí | 11 | 12 |
| časovač, který nic nečte | 10 | 9 |
| časovač kratší než 10 s | 8 | 6 |
| bez logiky | 0 | 1 (j05) |

**Proč záznam 5 padá** (soud cestou produktu): 12× `ACTION_LOST` + `RULE_INVALID` (logika
nezapojená a hra ztratí svědka věty; u útěků s003 h09 j10 může jít i o stav z `main` – Aréna
s `ruleRoles` ztratí svědka útěku i bez pravidel, viz T10), 4× jen
`RULE_INVALID` (mrtvá fáze nebo nespuštěný časovač), 3× `MALFORMED` (logika bez pravidel, která ji
čtou a mění – si-018), 3× `UNREPAIRED` (`wave` s `"at":"edge"` v žánru bez podlahy – střílečka
ma-048, si-031), 1× nečinný hráč vyhraje (d06: výhra na vstupu do fáze), 1× bez logiky.

**Odhad, ne měření:** model opíše začátek vzoru (fáze → časovač), ale druhou polovinu (časovač →
`goPhase` → reakce) dopíše jen v 6 z 25 a z nich projde 1 – zbytek padá na jiných vadách (vlna od
okraje mimo arénu, krátký časovač). Další páka podle záznamů není próza promptu: buď opravná kola
produktu (hlášky `no rule enters phase … add {"goPhase"}` model dostane, soud je ale jen první
odpověď), nebo stejná oprava čtení jako vstup do fáze (T11) pro časovač, který nikdo nespustí, a
fázi, do které nikdo nepřepne. Plán dovolil jednu další úpravu po záznamu 4; vyčerpaná, pokračuje T13.

## T13 – konečné měření na panelu P45A (`final.json`, `final.md`)

Panel P45A (40 vět), commit `f1b88a66`: logika v okamžitém návrhu **45 %**, hratelné 40/40
(včetně přehrání a nečinného hráče), p95 874 ms, novice 54/54 buněk P41 v pásmu – splněno.
Režisér 1/25 – nesplněno (T12a). Telemetrie P45A proti `main`: mrtvý čas 6,37 → 4,76 s, `rising`
0,40 → 0,48, finále 0,15 → 0,10 – jen zapsané, cíle zábavy patří P45C+D. Tabulky a výhrady:
`final.md`.
