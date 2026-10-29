# P66 – nové žánry a háčky

Plán: `plans/P66-nove-zanry-a-hacky-2026-10-28.md` (gitignorovaný). Každá úloha má svou sekci.

## T1 – štítky žánrů, dosah, otisk, zapečetěná sada, výchozí stav `main`

Všechno v T1 běží nad čistým `main` `e661855c` ve worktree `D:/caches/p66/main` (build `npm run build`), ne nad větví.

### Zapečetěná sada

`holdout.json` – 30 nových anglických vět napsaných 28. 10. 2026 před první změnou kódu P66: 15 míří na nové žánry (3 na každý: survivor, díra, krádež, třídění, šipky; `half: "new"`, `genre` = žánr, na který věta míří) a 15 obecných (`half: "general"`, `genre` = `classifyGenre` na `main` při zapečetění) přes 15 různých dnešních žánrů – hlídají, že nové žánry nekradou věty.

SHA-256 nad LF bajty: `42bf10ccca56ea5dab0b0c06cca9401701b3bb3980794c31da9a853c99c9e611` (`seal.ts`). Otevře se jednou v T16 (`openSealedOnce`); nic se podle ní neladí.

- `knownSets` = seznam P58B + každá `p56c/*.json` + sady P58B–P63, `p64/holdout.json` a `p66/dev.json`. `p64/holdout.json` v `main` ani ve worktree P64 28. 10. nebyl, takže ho pečeť porovná až po sloučení P64 (soubor, který neexistuje, se přeskočí).
- Rozbito schválně: změněný bajt sady a věta z dosavadní sady shodí 2 testy pečeti ze 4.

### Dev sada

`dev.json` – 20 nových anglických vět, 4 na každý nový žánr, s místem a věcmi. Ladí se jen na ní a na `p30/dev.json` [0..11].

### Štítky žánrů (`genre-labels.mjs` → `genre-labels.json`)

- 516 různých vět: sada 200 a 11 otevřených sad (počty po sadách v JSON `sets`).
- Slepý soudce `claude -p --safe-mode --tools ""` v prázdném `mkdtemp`. Vidí jen očíslované věty a 24 popisů typů her slovy pod klíči G01–G24, ne id z kódu.
- 26 dávek po 20 větách, souběh 1, pořadí dávek ze seedu v JSON; 26 volání, 0 selhání, 328 s.
- Na větu `best` (žánr, nebo `none` pro ne-hru) a `acceptable` (1–3 žánry, kde by věta dávala smysl).

### Podíl špatného žánru na `main` (`genre-route.mjs` → `route-main.json`)

`wrong` = věta s `best ≠ none`, jejíž žánr z rychlé hry (`classifyGenre(věta, null).ranked[0]`, bez modelu) není v `acceptable`. Ne-hry se nepočítají. Definici drží `__tests__/genre-route.test.ts` na třech ručních větách.

| Sada | vět | ne-hra | počítáno | špatný žánr | `wrongRate` |
|---|---|---|---|---|---|
| sada 200 | 200 | 25 | 175 | 68 | **0,389** |
| otevřené sady | 316 | 9 | 307 | 110 | **0,358** |

Pro srovnání žánr hotového návrhu (`draftGameSpecWithMeta`, přeskočí volbu, která se nepřeloží): 0,349 a 0,339 (`wrongRateDraft`). Stráž T12 a brána G6 berou `wrongRate`.

### Dosah nových žánrů

`best` / `acceptable` = počet vět, které soudce dal novému žánru jako nejlepší / přijatelný; podíl = `acceptable` / počet vět sady; „odkud“ = žánr, který těm větám dnes dá rychlá hra.

| Žánr | sada 200 `best` / `acceptable` | podíl | odkud | otevřené `best` / `acceptable` | podíl | odkud |
|---|---|---|---|---|---|---|
| survivor | 0 / 2 | 1,0 % | arena 1, quest 1 | 1 / 11 | 3,5 % | arena 5, shooter 3, quest 2, voyage 1 |
| díra | 1 / 6 | 3,0 % | arena 6 | 1 / 7 | 2,2 % | arena 6, quest 1 |
| krádež | 3 / 5 | 2,5 % | arena 4, quest 1 | 5 / 10 | 3,2 % | arena 6, quest 2, platformer 1, runner 1 |
| třídění | 3 / 8 | 4,0 % | arena 6, quest 1, rhythm 1 | 3 / 9 | 2,8 % | arena 4, quest 2, throw 2, merge 1 |
| šipky | 1 / 2 | 1,0 % | arena 2 | 0 / 2 | 0,6 % | quest 1, arena 1 |

Inference:
- Dnešní sady nové žánry skoro nechtějí: v sadě 200 je dohromady nejvýš 23 přijatelných vět (věta se může počítat u dvou žánrů), jako nejlepší jen 8.
- Skoro všechny dnes končí v `arena` (19 z 23), takže stráž krádeže v T12 hlídá hlavně arénu.
- Šipky a survivor mají v sadě 200 dosah 1 %, šipky na otevřených sadách pod 1 %. Podle „Co nevíme“ se staví dál, ale T12 jim dá jen úzké narážky.

### Otisk uložených her (`p66-hash.test.ts` → `hash-baseline.json`, commit `b787d657`)

- Robot a nečinný hráč na jedné uložené hře `genre.v5` každého z 19 žánrů (buňky `p58a/framing-cells.json`) a na uložených specech z `src/play/__fixtures__`; otisk stavu po konci běhu. 48 testů.
- Rozbito schválně: změněný seed jedné buňky shodí 1 test ze 48.
- Po T2 (`genre.v6`) zelený 48/48.

### Výchozí stav `main` (port 3167, `VERCEL_ENV=production`)

Server `shots.mjs serve`: čtečka astra placená, režisér objednaný, ale jeho model nikam nevede (`MODEL_UNAVAILABLE` je záměr), takže se platí jen čtení věty.

- **Dev listy** (`baseline-dev.json`): `shots.mjs` rychlá hra na `p30/dev.json` [0..11] (`D:/caches/p66/main-dev-p30`), rychlá i po čtení na `p66/dev.json` (`main-dev-p66`); `judge.mjs --view phone --judge claude --runs 2`. Hra ze čtení vznikla u 16 z 20 vět P66.

  | Strana (vět) | běh 1: věrnost / hrál bych | běh 2: věrnost / hrál bych |
  |---|---|---|
  | `p30` dev, rychlá (12) | 0,475 / 0,35 | 0,50 / 0,35 |
  | `p66` dev, rychlá (20) | 0,25 / 0,30 | 0,275 / 0,30 |
  | `p66` dev, po čtení (20; hra ze čtení, jinak rychlá) | 0,275 / 0,30 | 0,275 / 0,275 |
  | `p66` dev, jen hra ze čtení (16) | 0,30 / 0,325 | 0,30 / 0,35 |

  Rozptyl soudce: 48 párů, medián rozdílu 0, nejvíc 0,12 věrnost a 0,10 „hrál bych“. Druhý běh 28. 10. narazil na limit předplatného (30 listů bez odpovědi) a doběhl 29. 10. na týchž listech.

  Inference: věty na nové žánry dostávají na `main` věrnost 0,25 proti 0,475 u obecných dev vět – tam je prostor P66.

- **Start** (`baseline-start.json`): `first-playable-ab.mjs`, `pixel7-cpu4`, 3 běhy, 5 dev vět (3 z `p66/dev.json`, 2 z `p30/dev.json`). Obě strany jsou tentýž server `main` (A/A), takže číslo říká i šum stroje.

  | Věta | hratelná A / B (ms) | párový rozdíl (ms) | první snímek A / B (ms) |
  |---|---|---|---|
  | zombie shooter in a mall | 11 248 / 12 167 | +502 | 6 269 / 6 007 |
  | a space marine shoots alien bugs… | 9 541 / 9 927 | +301 | 6 009 / 5 363 |
  | a little robot auto-fires at swarms… | 9 361 / 9 556 | +313 | 5 912 / 6 271 |
  | a black hole swallows the cars… | 11 125 / 10 631 | −494 | 6 316 / 6 102 |
  | sort the colourful candies… | 27 122 / 21 381 | −3 714 | 6 661 / 6 952 |

  Inference: šum A/A (párově 0,3–3,7 s) je větší než práh G3 (+0,2 s). T16 proto musí měřit prokládaně a brát medián párových rozdílů přes všech 15 párů, ne jednotlivé věty.
- **FPS** (`baseline-fps.json`): `e2e/play-perf.spec.ts @measure` s jednou větou na žánr z `perf-genres.json` (`PERF_GAMES_FILE`, změna spec souboru je v tomto commitu), telefonní profil 412 × 823, CPU 4×, 3 běhy. Medián `fpsP50` přes 19 žánrů 59,9; **nejpomalejší `runner` 30 fps** (kresleno 31,1), `defense` také 30. Práh G4 pro nové žánry = 0,95 × 30 = 28,5 fps.
- **Zapečetěná sada**: snímky rychlé hry i hry po čtení do `D:/caches/p66/main-holdout/`, **nesouzené**. Všech 30 vět má snímky rychlé hry; hra ze čtení vznikla u 15 z 30 (u obecné poloviny většinou ne – čtečka nechá rychlou hru). Focení začalo 28. 10. a po přerušení (9 vět) doběhlo 29. 10. tímtéž `shots.mjs` na týchž buildech.

### Útrata čtení T1

| Krok | volání | USD |
|---|---|---|
| dev `p66/dev.json` po čtení | 20 | 0,66 |
| zapečetěná sada po čtení | 31 | 0,99 |
| **T1 celkem** | 51 | **1,65** |

Rozpočet T1 byl 1,50 USD (+0,15). Na T13, T15 a T16 zbývá 2,35 USD z 4 USD proti plánovaným 1,80. Soudci: štítky 26 volání `claude -p`, dev listy 64 volání `claude -p` (32 listů × 2 běhy), vše předplatné.

### Kudy dnes jde výběr žánru (řádky na `main` `e661855c`)

- **Rychlá hra:** `src/play/genre/classify.ts:420` `classifyGenre`. Pravidla slovesy jsou regulární výrazy nad ř. 100–390, dvojice žánr × režim `PAIRS` ř. 391, kostry vyřazené ř. 424 (`availability !== 'staged'`).
- **Narážky:** pole `cues` v modulu žánru (`src/play/genre/<g>.ts`, např. `arena.ts:148`; typ `genre/contract.ts:304`). Žánry pruhů mají `cues: []` a vede je sloveso.
- **Návrh:** `src/play/draft/draft.ts` – `TEMPLATE_TITLE` ř. 278, `GENRE_SETTING` ř. 1129, výběr místa ř. 1315, `draftGameSpecWithMeta` ř. 1484 volá `classifyGenre` ř. 1507.
- **Řetěz:** `src/play/chain/build.ts` – `VERB_MICROS` ř. 64, `WORLD_MICROS` ř. 83, `VERB_BOSS` ř. 105.
- **Schopnosti:** `src/play/capabilities.ts:96` `CAPABILITIES` (záznam na každé ovládání).
- **Režisér:** `src/play/director/prompt.ts` – seznam žánrů se skládá z `GENRE_MODULES` (jen režimy `ready`), `GENRE_PITCH` ř. 123 pro žánry bez narážek, boss ř. 173.
- **Čtečka:** `src/play/read/prompt.ts` – `READY_GENRE_MODES` (ř. 9, popisy ř. 31), `PROMPT_EXAMPLES` ř. 75.

### Kudy jdou kombo, finále a boss

- **Kombo:** `COMBO` `arcade/contract.ts:230` (okno 90 tiků, nejvýš ×5); zdroje `COMBO_SOURCES` `arcade/compile.ts:310`, napojení `withCombo` ř. 272 a 303. Na obrazovce `comboOf` `effects/feel.ts:70` a pilulka `PowerupBadge.tsx`.
- **Finále:** `FINALE_GENRE_VERSION = 'genre.v4'` `pieces/pacing-parts.ts:1034`, bosse finále `finaleBossesOf` `pieces/pacing.ts:957`.
- **Boss:** `BOSS_ATTACKS` `arcade/contract.ts:382`, ve schématu `genre/contract.ts:171`; plní ho režisér (`director/prompt.ts:173`).

## T2 – kostry pěti žánrů, `genre.v6`, kontrakt háčků

### Vstup klepnutím pro třídění a šipky: vstup pruhů, nový vstup `pick` nevznikl

- **Zjištění.** Záznam hry je `InputEvent` = `{ tick, buttons, axis }`; osa je celé číslo −1000..1000 a 0 znamená „bez vstupu“. Vstup pruhů (`genres/lanes/lanes-input.ts`) dnes čte jen vodorovnou polohu prstu: pět pásem, nebo hranice pruhů, které scéna zapíše do `data-lane-edges`.
- **Třídění** jde přes `lanes` beze změny: sloupec pod prstem je fronta. Scéna zapíše hranice front do `data-lane-edges`, ovládání čte `laneOfAxis`.
- **Šipky** jdou přes `lanes` s buňkou v ose: `axisOfCell(cell) = cell + 1` (`pieces/lanes.ts`), tedy mřížka do 999 buněk. Plátno buňku spočítá, když scéna zapíše `data-lane-cells` ve tvaru „sloupce,řady,vlevo,nahoře,vpravo,dole“ (hranice mřížky ve zlomcích plátna; `cellAxisAt`). Ťuk mimo mřížku nepošle nic. Bez atributu se vstup pruhů nemění, takže dosavadní žánry pruhů hrají stejně.
- **Proč ne `pick`.** Nový `Stage['input']` by potřeboval:
  - nový hook v `ArcadeStage.tsx` mimo větev výběru scény, což je mimo rozsah T2 a v souběhu s P64;
  - nový případ v mapě VR;
  - u pole `cell` nový formát záznamu i výzvy (`score/dare.ts`).

  Osa buňku unese beze změny formátu a hash her `genre.v5` se nehne.

### Sdílené registry (jednou, ať T5–T9 sahají jen na své soubory)

| Kde | Co přibylo |
|---|---|
| `genre/contract.ts` | `GENRES` (24), `GENRE_MODES`, varianty schématu, `FOE_DOES`, `COUNT_PARAMS`; `GENRE_COMPILER_VERSION = 'genre.v6'` |
| `genre/modules.ts`, `genre/<g>.ts` | pět modulů `stagedGenre` (meze parametrů pro počty z `COUNT_PARAMS`) |
| `genre/roles.ts` | `GENRE_FOE` (výchozí nepřítel podle žánru): goblin, car, robot, fruit, car. Jen slova, která `DEFAULT_LABELS` už má. Nové výchozí slovo by změnilo, které popisky z věty dostanou model (`_upgrade.ts`) a které se převlečou s místem (`compose.ts`), i u dnešních her. „guard“ shodil `goal-text.test.ts` u věty se strážcem. |
| `spec.ts` | ovládání `survivor`, `hole`, `steal`, `sort`, `arrows` v `CONTROLS` a `STAGED_CONTROLS` (čtečka je nenabízí), parametry ovládání |
| `capabilities.ts`, `draft/unsupported.ts`, `read/for-chain.ts` | řádky ovládání (typ `Record<ControlId, …>`); popisy vlastními slovy, bez jmen cizích her |
| `compose/stage-registry.ts` | `survivor`, `hole`, `steal` → vstup `arena`; `sort`, `arrows` → vstup `lanes`; scéna = jméno žánru |
| `compose/presets.ts` (`STAGED_PRESETS`), `intent/contract.ts` (`GENRE_ACTIONS`) | recepty koster: `autofire`, `swallow`, `steal`, `sort`, `unblock` – každá dělá z receptu celou hru (`wholeGame`), takže `assemble.ts` ani `recipe.ts` změnu nepotřebovaly |
| `arcade/library.ts` | ovládání `<g>`, robot `<g>_bot`, generátor (`survivor_waves`, `hole_swallow`, `steal_bases`, `sort_bins`, `arrows_grid`), pravidla `<G>_RULES` z `pieces/<g>.ts` a `<g>-bot.ts` |
| `arcade/pieces/mode-stub.ts` | `controlStub`, `botStub` a `modeStub` s vlastním ovládáním a robotem: generátor vrátí `issues`, takže svět nevznikne a hra neprojde publikační branou |
| `ArcadeStage.tsx` | jen větev výběru scény → `genres/<g>/<G>Scene.tsx` (podlaha `FieldGround`) |
| `draft/draft.ts` | `GENRE_SETTING` (ruined town, busy city, rival base, toy shop, parking lot). `TEMPLATE_TITLE` beze změny: po recenzi T2 se druhy nových žánrů vrátily ven, protože odmítaly čtené názvy dnešních her („Museum Heist“). Přidá je T12, až žánr pustí do rychlé hry |
| `playwright.config.ts`, `e2e/play-<g>.spec.ts` | `pixel7-touch` dostal pět specifikací; `chromium` je bere sám (nejsou v `testIgnore`); každá zatím jeden `test.skip` |

Jména kusů, ovládání, generátorů a robotů drží úlohy žánrů beze změny. Přejmenování by znamenalo sahat do `library.ts`.

### Kontrakt háčků `arcade/hooks/contract.ts`

- `ROUNDS`: 1–5 kol, přestávka 90 tiků.
- `UPGRADES`: `speed`, `fire_rate`, `range`, `extra_life`, `magnet`, `carry`. K tomu `UPGRADE_STEP` (co dá jeden stupeň) a `UPGRADE_OFFER`: 3 karty, 300 tiků na volbu, výchozí karta 0, nejvýš 3 stupně.
- `RARITY`: váhy 70/25/5, násobič skóre ×1/×3/×10.
- `HOOK_SLOTS`: stav na těle-počítadle za tělesy úrovně – kolo, přestávka, nabídka, tiky na volbu, stupně vylepšení, nálezy. Vzácnost jednotlivé věci nese věc sama; kde přesně, rozhodne T3.
- **Volba karty je vstup:** nová tlačítka `BUTTON.PICK_1..3` (bity 11–13), které uložený záznam mít nemůže. `score/dare.ts` je přijme samo, protože masku tlačítek skládá z `BUTTON`.
- **Zprávy pro obrazovku** (`HookEffect` v `ArcadeEffect`): `score_pop`, `callout` (uzavřený seznam id), `round_start`, `round_clear`, `upgrade_offer`, `upgrade_pick`, `rare_found`, `boss_enter`. Stav nemění; jádro je jen propouští (1 řádek v `kernel.ts`), ověření je nehlásí (`verify.ts`).
- **Streamy** `upgrades`, `rarity`, `rounds` jsou připsané za `chain` v `src/sim/rng.ts`, takže dřívější streamy losují totéž.

### Šev na výšku `genres/portrait-first.ts`

- `fitTall(camera, box, rect)` vrátí `{ distance, shift }`:
  - `distance` = vzdálenost kamery od středu krabice po dosavadním směru pohledu;
  - `shift` = svislý posun v px pro `camera.setViewOffset(w, h, 0, shift, w, h)`.
- Pro perspektivu je fit přesný: každý roh krabice má svou hloubku. Mezi krabicí a hranou pásu zbývá okraj 8 px.
- Na `aspect ≥ 1` vrací vstupní pózu (`shift` 0).
- **Pás hry** se počítá z tokenů kitu, ne z DOM (`tokenRect`):
  - nahoře `HUD_BAND_PX` = 16 + 50 + 12 = 78 px;
  - dole `THUMB_ZONE_PX` = 16 + 62 + 12 + 62 + 12 = 164 px (dolní řada HUD a řada ovládání palcem).
- Tvar volání podle textu P64 T2. Soubor `portrait-frame.ts` ve worktree P64 28. 10. ještě nebyl, takže T14 musí tvar ověřit proti skutečnému souboru.

### Nálezy pro další úlohy

- **Joystick se na telefonu nekreslí.** Vizuální joystick (`TouchStick`) `ArcadeStage.tsx` ukazuje jen pro `move_free` a `fight`. Survivor, díra a krádež se ovládají tahem prstem kdekoli (`useArenaInput`), ale kroužek pod palcem chybí. Řádek leží mimo větev výběru scény (rozsah T2) a P64 ho přesouvá do zóny palce, proto → T14 po sloučení P64.
- **VR:** třídění hraje přes osu pruhů. Šipky (buňka ve 2D) páčka nevybere, takže T9 rozhodne, že je VR nenabídne.
- **Zmrazené výsledky po zvednutí na `genre.v6` byly přepočítané**, stejně jako v P51:
  - `evals/play/p41/golden/genres.json` (generátor `freeze.measure.ts -t "writes genres.json"`): rozdíl je jen 323× `compilerVersion` a 287× `specHash`; `replays.json` je bajt po bajtu stejný, takže svět ani robot nové hry se nepohnuly.
  - `evals/play/p41/difficulty.json` (`difficulty.measure.ts`): `specHash` se posunul u 35 z 62 buněk.
  - **Řádky běhů se změnily u šesti buněk** (`roam.catch`, `catch`, `whack`, `defense`, `slice`, `merge`; 40 řádků každá) a v souhrnu dvou z nich (`catch`, `merge`). **Na T2 to nezávisí – změřeno 29. 10.:** `difficulty.measure.ts` přeměřený na čistém `main` `e661855c` (worktree `D:/caches/p66/main`) dává řádky běhů i souhrny shodné s větví (0 rozdílných řádků; liší se jen `specHash` 35 buněk kvůli `genre.v6`). Proč soubor zastaral:
    - spec `roam.catch` se nepohnul, a běhy přesto ano;
    - soubor se naposledy měřil v P54C (21. 10.) a P55 (události pruhů), P58A, P61 a P63 světy těch buněk změnily;
    - `difficulty.test.ts` řádky nehlídá, jen `specHash` a meze.
- **`GENRE_COMPILER_VERSION` má typ `string`.** S doslovným typem by stráž `!== 'genre.v5'` v `p66-hash.test.ts` po zvednutí verze neprošla `tsc` ani buildem.
- **Soubory mimo seznam T2, které typy nebo testy vyžádaly:**
  - `verify.ts` – vyčerpávající `switch` efektů;
  - `kernel.ts` – zprávy háčků stav nemění;
  - `read/for-chain.ts`;
  - `pieces/lanes.ts` a `lanes-input.ts` – buňka v ose;
  - `sim/rng.ts` – streamy;
  - testy, které čekaly 19 žánrů, verzi `genre.v5` nové hry nebo volný bit 12:
    - `doubles.ts`, `hero-animals.test.ts`, `dressing.test.ts` (jen žánry, které hrají);
    - `pacing-template`, `p51-assembly-runner`, `p51-dead-time`, `p52-fight-balance` (nová hra je `genre.v6`);
    - `chain/__tests__/run.test.ts` (`chain` už není poslední stream);
    - `score/__tests__/dare.test.ts` (cizí tlačítko je bit 20);
    - `p56a` a `p58b` – zapečetěné sady před P66, nové žánry v nich být nemůžou;
  - `e2e/p61-portrait.spec.ts`: kostru přeskočí, protože hru nepostaví.
- **Testy:**
  - `npx vitest run src/play/genre src/play/arcade src/play/compose src/components/play/arcade` zelené po opravách; první běh měl 334 červených, z toho 323 v zmrazených specech `presets.test.ts`;
  - druhá dávka `src/play/__tests__`, `chain`, `director`, `read`, `xr`, `draft`, `score`, `intent`, `fidelity`, `src/sim`, `evals/play/{p41,p47a,p54c,p56a,p58b}` zelená;
  - otisk T1 `p66-hash.test.ts` zelený (48/48);
  - `tsc --noEmit` čistý.

## T3 – háčky v jádře: kola, výběr vylepšení, vzácnost, boss, zprávy skóre

Kontrakt z T2 (`hooks/contract.ts`) se nezměnil: tvary `HookEffect`, `CALLOUTS`, `UPGRADES`, význam `HOOK_SLOTS` i `UPGRADE_PICK_BUTTONS` jsou tytéž.

### Co přibylo

| Kde | Co dělá |
|---|---|
| `arcade/hooks/index.ts` | pravidlo `hooks` (nese parametry, samo nic nevystřelí, jádro je čte v `loadProgram` jako `score_bonus`); `withHooks` (počítadlo háčků za tělesy úrovně + pravidlo + robot `hooks_bot`); `hookTuningOf` (klíče `tuning`); `hooksStart` / `hooksEnd` pro jádro; létající skóre a hlášky komba |
| `arcade/hooks/rounds.ts` | kola, přestávka po kole, `round_start` / `round_clear`, výhra až po posledním kole; `roundSeeds` (rozvrh kol ze streamu `rounds` pro nové žánry) |
| `arcade/hooks/upgrades.ts` | nabídky ze streamu `upgrades`, volba ze vstupu, výchozí karta 0, promítnutí do hrdiny, robot `hooks_bot` s pevným pořadím `UPGRADE_PRIORITY` |
| `arcade/hooks/rarity.ts` | losy ze streamu `rarity`, vzácnost při vzniku věci, body × násobič, nálezy ve stavu |
| `arcade/hooks/boss.ts` | `boss_enter` + hláška `boss`, když vstoupí kopie předlohy bosse finále (`boss_beat`) |
| `kernel.ts` | `ArcadeProgram.hooks`; dvě volání v `step` (začátek tiku, před bonusem výhry) |
| `compile.ts` | klíče háčků z `tuning` jen od `genre.v6`; `COMBO_SOURCES` za `genre.v6` doplní pravidla nových žánrů |
| `library.ts` | pravidlo `hooks`, robot `hooks_bot` |

`components/play/arcade/bot-hand.ts` změnu nepotřeboval: bere robota světa z knihovny, a to je `hooks_bot`.

### Jak to v jádře běží

- **Stav háčků** nese počítadlo háčků (`keeper` v parametrech `hooks`), mrtvá předloha za tělesy úrovně jako počítadlo komba. Sloty jsou posun od `bodyBase(keeper)`:
  - `HOOK_SLOTS.round` (`BODY.x`) – kolo 0..`rounds`−1;
  - `breakLeft` (`BODY.y`), `pickLeft` (`BODY.vx`) – zbylé tiky přestávky a volby;
  - `offer` (`BODY.z`) – karty po 8 bitech, kód = index v `UPGRADES` + 1, karta 0 v nejnižších;
  - `levels` (`BODY.vy`) – stupně po 4 bitech v pořadí `UPGRADES`;
  - `found` (`BODY.vz`) – nálezy po 10 bitech: `common` bity 0–9, `rare` 10–19, `epic` 20–29;
  - mimo kontrakt `RARITY_SLOTS.drawn` (`BODY.aux0`) – kolik losů vzácnosti už věci dostaly.

  Čtení: `foundOf(state, keeper)`, `upgradeLevel`, `offerOf`, `roundOf`, `rarityOf` z `@/play/arcade/hooks`; `keeper` = `hooksOf(world.rules)?.keeper`.
- **Tik:** `hooksStart` na začátku – v přestávce svět stojí (ovládání, pravidla, fyzika ani milost neběží, tik ano) a jde jen volba karty a odpočet; jinak promítne vylepšení do hrdiny. `hooksEnd` po průchodech pravidel a logiky, před bonusem výhry: sebrání se vzácností, létající skóre, hlášky komba, vstup bosse, losy nových věcí, kola.
- **Kola:** konec kola hlásí žánr signálem `clear`:
  - `wave` – žánr zvedl čítač vlny (`waveOf`) nad běžící kolo, kolo = vlna;
  - `win` – výhra pravidla žánru, před posledním kolem z ní je jen vyčištěné kolo.

  Výhra před posledním kolem se vrací na běh; prohra platí kdykoli. Po `round_clear` přestávka: bez nabídky `ROUNDS.breakTicks` (90), s nabídkou do volby, nejdéle `pickTicks` (300). Pak hned `round_start` dalšího kola.
- **Vylepšení:** pořadí zásoby na každou přestávku losuje stavba ze streamu `upgrades` (`drawOffers`, Fisher–Yates) a nese ho pravidlo `hooks`. Nabídka = první tři pod stropem 3 stupňů. Volba = `BUTTON.PICK_1..3` v tiku přestávky (nejnižší stisknutá); bez volby po `pickTicks` karta 0. Jádro samo promítne:
  - `speed` – posun navíc o 15 % rychlosti za stupeň na začátku tiku, rychlost se nemění, takže se nesčítá;
  - `magnet` – věci do 1,5 m za stupeň letí k hrdinovi krokem magnetu power-upu;
  - `extra_life` – +1 život při volbě;
  - `fire_rate` na ráně, kterou ovládání píše do těla hráče (`Swing`; souboj: `aux1`, `FIGHT.attackCooldown`) – o 20 % kratší za stupeň.

  `range` a `carry` a `fire_rate` vlastní rány nového žánru jsou jen stupně ve stavu, čte je kus žánru (`upgradeLevel`).
- **Robot:** `hooks_bot` obalí robota světa. V přestávce s nabídkou stiskne jednou kartu podle `UPGRADE_PRIORITY` (`extra_life`, `fire_rate`, `speed`, `range`, `magnet`, `carry`); vidí stav starý 8 tiků jako každý robot, takže kartu bere 9 tiků po nabídce. Jinak v přestávce nic, mimo ni rozhoduje robot pod obalem. Nečinný hráč nevolí a dostane kartu 0.
- **Vzácnost:** losy (128 na hru, `simplified` v `rarity.ts`) ze streamu `rarity` nese pravidlo. K-tá věc, která vznikne (tělo úrovně, kopie ze `spawn`, přepnutím objevená), dostane k-tý los na konci tiku vzniku. Kód 0–3 je v bitech odrazu `flags` nefyzikální věci (`RESTITUTION_SHIFT`, jako milost hráče). Bity stavu cíle to být nemohly, chytání v nich nese propadlé ovoce. Sebrání = dvojice kladné `score` a hned `despawn` sbírané věci (tak sbírá `pickup` i `arena_eat`): body navíc do násobiče, nález do `found`, `rare_found` u vzácné a epické, hláška `epic_find`.
- **Boss:** nic nového se nepíše. Předlohu bere `completeHooks` z `boss_beat` (finále `pacing-parts`), `boss_enter` jde za každý `spawn` té předlohy, tělo = živá kopie na místě vstupu.
- **Zprávy:** `score_pop` za každé kladné `score` / `count score` tiku (tělo = věc nebo cíl hned za ním, jinak hrdina); hlášky `combo_2`, `combo_3`, `combo_max`, když násobič komba přejde 2, 3 a strop (`COMBO.max`). Počítadlo komba doplní `completeHooks` z pravidel `COMBO_SOURCES`.

### Dosavadní žánr s koly a výběrem: arena `fight`

**Rozhodnutí (`implementation-notes`):** háčky dosavadního žánru zapnou klíče `controlParams.tuning` – schéma `GameSpec` je pustí (`tuning` je záznam čísel, pravdivostí a krátkých řetězců), takže se `spec.ts` nemění. `compile.ts` je čte jen od `genre.v6` a před generátorem je zahodí. Starší spec je předá generátoru jako dřív a striktní schéma generátoru ho odmítne – stejně jako dnes. Klíče: `hookRounds` 1–5, `hookUpgrades` (zásoba čárkami), `hookRarity: true`.

Ruční spec `genre.v6` (celý v `src/play/arcade/hooks/__tests__/hooks-fight-spec.json`, souboj arény, bez klasifikátoru):

```json
"controlParams": { "generator": "fight", "tuning": { "enemies": 3, "waves": 3, "hookRounds": 3, "hookUpgrades": "speed,fire_rate,extra_life" } },
"genre": { "id": "arena", "mode": "fight", "compilerVersion": "genre.v6" },
"mechanics": [{ "id": "health", "params": { "max": 3 } }]
```

- **Proč souboj:** jeho výhra (`fight_end`) přijde až v poslední vlně, takže kolo = vlna sedí (`clear: 'wave'`).
- **Proč ne sběr arény:** vyhrává skóre (`grow_to`). Sprška šablony a pád bosse ho dají dřív než poslední vlnu – robot pak v kolech nedohrál (změřeno na „a squirrel collects acorns in the park“, semínko 1).
- **Proč tyhle tři karty:** souboj nemá věci, takže `magnet` by nic nedělal; `fire_rate` zkrátí úder.
- **Pojistky v `compile.ts`:** kola musí rovnat počtu vln `arena_waves` a karta, která by ve hře nic nedělala (`extra_life` bez životů, `magnet` bez věcí, `fire_rate` bez rány, `range`, `carry`), je chyba s důvodem.
- **Změřeno (semínka 1–3):** robot vyhraje (1659 / 1752 / 1750 tiků), nečinný prohraje, dvě nabídky, robot bere `extra_life` 9 tiků po nabídce, boss vstoupí na začátku 3. kola, `round_clear` třetího kola je v tiku výhry. `compileArcade` a `verifyArcade` projdou.
- Kolo končí, když žánr zvedne vlnu. Souboj ji zvedá 60 tiků po pádu posledního soupeře (`FIGHT_WAVES.pause`), takže noví soupeři už stojí, když se přestávka otevře.

### Pro další úlohy

- **T4:**
  - `round` je od 0 („Round 2 of 3“ = `round + 1` z `rounds`);
  - v přestávce svět stojí a hodiny hry běží (`HEADER.tick`, `time_limit`);
  - nálezy pro výsledek: `foundOf(state, hooksOf(world.rules)!.keeper)`;
  - fixture souboje věci nemá, takže nálezy jsou 0. Nenulový řádek vzácností potřebuje `hookRarity: true` na žánru se sběrem, který nevyhrává skóre.
- **T5–T9:**
  - háčky si přidá generátor žánru: `withHooks(parts, seed, { rounds, clear: 'win', upgrades, rarity })` vrátí i `keeper` pro parametry vlastních kusů;
  - kolo hlásí výhrou (`clear: 'win'`) a obsah dalšího kola staví podle `roundOf`, semínka kol z `roundSeeds`;
  - kombo: pravidlo, které vezme parametr `combo` (jako `pickup`), se stane zdrojem komba samo (`hookedComboSources`) – dnes jsou tabulky nových žánrů prázdné, takže to nic nemění a test to zatím nedrží.
- **T10:**
  - žánr, který vyhrává skóre (sběr arény), s vlnami jako koly nesedí, viz výš; se vzácností by cíl skóre přišel ještě dřív;
  - `range` a `carry` dosavadní žánry nemají a `fire_rate` jen souboj – projekce dalších ran patří do `hooks/upgrades.ts`, což není v souborech T10;
  - `hooks_bot` chybí ve `WRAPPING_BOTS` (`addons.ts`). `baseBotOf` přes něj nevidí, takže scéna plavby a sonda skákání by ve světě s háčky nenašly svého robota. Souboj to netýká; doplnit, až háčky dostane plavba nebo skákání.
- Násobič vzácnosti se připíše na konci tiku, takže cíl skóre (`score_bonus`, `grow_to`) ho uvidí o tik později.

### Testy (`src/play/arcade/hooks/__tests__/`)

`rounds`, `upgrades`, `rarity`, `boss`, `replay` (+ `harness.ts`, `hooks-fight-spec.json`). Drží:

- týž seed = tytéž nabídky, vzácnosti a rozvrh kol, jiný seed jiné;
- volba v záznamu přehraje shodně, jiná volba = jiná hra;
- nevybraná nabídka = karta 0 přesně po `pickTicks`;
- `rounds = 3` vyhraje až po třetím `round_clear`;
- přestávka zastaví svět;
- `genre.v5` háčky nemá a háčky ve `genre.v6` světě jen přidávají;
- zprávy háčků projdou skutečným tikem jádra beze změny stavu, se světem s háčky i bez nich;
- vzácnost při vzniku nezávisí na pořadí sebrání;
- `boss_enter` jednou v posledním kole;
- publikační brána projde.

Běhy (JSON reporter):

- `npx vitest run src/play/arcade` – 3893 zelených, 1 červený: `swarm.test.ts` (f), strop 0,05 ms na tik naměřil 0,078 ms. Stroj byl pod zátěží souběžných e2e P64. Samotný soubor znovu zelený (64/64 s háčky), háčků se netýká.
- Háčky 54/54, otisk T1 `p66-hash.test.ts` 48/48.
- `npx vitest run src/play/genre src/play/compose src/play/score evals/play/p41` – 4137/4137. Zmrazené výsledky P41 se nepohnuly, `git status` žádný artefakt nepřepsal.
- `tsc --noEmit -p .` čistý.

### Rozbít schválně (`mutationStatus`)

Jedna záměrná chyba na vlastnost, pak soubor zpět ze zálohy (`D:/caches/p66/t3-backup/`, `diff -q`). Každá shodila aspoň jeden test.

| Vlastnost | Záměrná chyba | Červené testy |
|---|---|---|
| nabídky ze semínka hry | `drawOffers`: `createStreams(0)` | 1 – `upgrades` „same seed … other seeds other ones“ |
| vzácnost ze semínka hry | `drawRarities`: `createStreams(0)` | 3 – `rarity` (semínko, váhy, epický nález) |
| rozvrh kol ze semínka hry | `roundSeeds`: `createStreams(0)` | 1 – `rounds` „roundSeeds …“ |
| volba je vstup v záznamu | přestávka bere kartu robota (`priorityCard`) místo vstupu | 8 – volba karty 0/1/2, výchozí karta, život, jiná volba = jiná hra, přestávka, robot |
| vzácnost při vzniku | los až sebrané (mrtvé) věci v tiku sebrání | 2 – `rarity` „level things …“, „collected in either order …“ |
| výhra až po posledním kole | `last = round >= 0` (každé kolo poslední) | 20 – kola, přehrání, boss, volby |
| totéž úžeji | výhra v kole 0 platí | 3 – `rounds` (výhra pravidla v kole 1 a 2, jediná výhra, čekající výhra vlny) |
| nevybraná nabídka = karta 0 | výchozí karta 1 | 1 – `upgrades` „nobody picks …“ |
| háčky jen od `genre.v6` | `compile.ts` čte klíče háčků u každé verze | 1 – `rounds` „a genre.v5 spec has no hooks …“ (otisk T1 zůstal zelený, uložené specy klíče nemají) |
| zprávy háčků stav nemění | jádro přičte `score_pop` ke skóre | 2 – `replay` průchod zpráv se světem s háčky i bez nich |
| přestávka zastaví svět | `hooksStart` po tiku přestávky pustí i zbytek tiku | 9 – kola, boss, výchozí karta, robot, přestávka |

`mutationStatus: all-red` (11/11).
