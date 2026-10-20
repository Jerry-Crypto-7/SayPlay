# P54C – nové žánry: osm nových herních smyček, každá ověřená robotem

Plán `plans/P54C-nove-zanry-2026-10-19.md` (necommitovaný). Větev `features/P54C-nove-zanry-2026-10-19` z `origin/main` `1476989e` (P52 sloučený jako #39).

## Výchozí stav (`start.json`, T1)

Píše ho `start.measure.ts`; `P54C_CHECK=1` nic nepíše a jen porovná věty a živé buňky se zapsaným souborem (důkaz „nic se nepohnulo“).

- **Replay brána** (7 souborů z plánu): 80/80 zelených.
- **Grep determinismu** (`Math.random|Date.now|performance.now` v `src/play/arcade`, `compose`, `genre`): 6 řádků, všechny v testech (měření času), žádný v kódu hry. Nový kód počet nezvedne.
- **Živé buňky:** 54.
- **P30 dev (60 vět):** klasifikátor bez čtení modelem a žánr návrhu na semínku 1 (Rapier načtený). Žádná věta nepadá do náhradního režimu ani nehází. Návrh: sběr v aréně 11, běžec 8, hod 6, plavba 6, útěk v aréně 5, úkol u stanoviště 4, po 3 střílečka, souboj, souboj v aréně, stavění, úkol v prostoru, po 2 plošinovka a rytmus, poletování 1.

## Sady (T2)

- **`dev.json`** – 80 vět napsaných 19. 10. před prvním během: 8 na každý z osmi nových žánrů (`expect` = `<žánr>.default`) a 16 pastí (`family: "trap"`), které používají lákavé slovo nového žánru v jiném smyslu („the police try to catch the thief“, „chop wood and build a cabin“, „merge into traffic and race“). Štítek pasti je žánr, který autor myslel; brána T13 ale porovnává pasti s `baseline.json`, ne se štítkem. Ladí se jen na téhle sadě.
- **`holdout.json`** – 80 vět, které napsal nezávislý subagent bez přístupu ke kódu, plánům a sadám. Dostal jen osm jmen a jednovětých popisů žánrů, tvar záznamu a pokyn psát přirozené věty hráčů 13+: 60 cílových (8 na catch, whack, defense, slice, 7 na hop, crowd, merge, push) a 20 rušivých (`genre: null`). Soubor zapsal sám a vrátil jen otisk a počty. **SHA-256 nad LF bajty: `c3d545c53a59d8569f264466818bf3172fbba49a9914928d1efd7b6e650eca68`** (hlídá `__tests__/sets.test.ts`). Do T16 ho čte jen test otisku, tvaru a kolizí (do výstupu jdou jen id).
- Kolize: h03 se shodovala s dev větou f03, protože brief subagentovi ji uváděl jako příklad. Změnila se dev věta (f03 teď „stop the skeletons before they break into the barn“), holdout zůstal; h03 tedy není nezávislá věta a T16 ji tak čte.
- Žádná věta dev ani holdoutu se po `normalizeSentence` neshoduje s jinou sadou `evals/play/**` (soubory do 1 MB) ani mezi sebou.

## Výchozí stav dev sady (`baseline.json`, po T2)

Píše ho `P54C_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p54c/classify.measure.ts` (klasifikátor bez čtení modelem + žánr návrhu na semínku 1, Rapier načtený).

| Žánr | Kam dnes padá 8 vět (žánr návrhu) |
|---|---|
| catch | sběr v aréně 6, úkol v prostoru 1, běžec 1 |
| whack | úkol v prostoru 5, sběr v aréně 2, útěk 1 |
| defense | souboj v aréně 4, sběr v aréně 2, souboj 1, střílečka 1 |
| slice | plavba 4, souboj v aréně 2, sběr v aréně 1, hod 1 |
| hop | běžec 4, plošinovka 3, plavba 1 |
| crowd | běžec 3, sběr v aréně 2, úkol v prostoru 1, souboj 1, úkol u stanoviště 1 |
| merge | úkol u stanoviště 6, sběr v aréně 1, hod 1 |
| push | sběr v aréně 5, plavba 1, souboj 1, plošinovka 1 |

- Žádná věta nehází a žádná nepadá do náhradního režimu. Pasti: 8/16 hrají žánr, který autor myslel; zbylých 8 hraje jiný starý žánr (např. „police try to catch the thief“ běžec místo útěku) – T13 je drží beze změny proti tomuhle souboru.

## T3 – míčové věty na živé cestě (`ball-path.json`)

- Šest vět (tři ze sondy 19. 10., tři míčové z `p41/sentences.json`) přes `POST /api/play/games` na `next start`: **všech šest hraje míč**, ověření serveru `bot_wins`, `idle_loses`, `replay_equal` zelené. Chyba „No playable assembly: assembled.ball“ byla jen v sondě, která stavěla návrh bez `loadRapier()`. Server Rapier čeká vždy (`games/route.ts`, `director/index.ts`), oprava kódu hry není potřeba.
- `src/play/compose/__tests__/ball-assembly-path.test.ts` to drží: bez Rapieru návrh nahlas odmítne (nikdy tiše nehraje jinou hru), s Rapierem všech šest vět dá `control: ball`.
- **`e2e/play-ball.spec.ts` byl na `main` červený** (4/4) a nesouvisel s větami: od P51 balí ovládání míče `pacing_control`, takže pomocník `replayState` (`e2e/play-native-input.ts`) nenačetl Rapier, a živá hra má před výkopem hráče na hřišti i míč soupeře z finále, na který test mířil. Pomocník teď Rapier čeká vždy a test bere posledně spawnutý míč; 4/4 zelené.
- Mimo T3: hláška poctivosti „The obstacles isn't here yet“ má špatný tvar slovesa pro množné číslo (copy P44, ne žánry).

## T4 – kostra osmi žánrů a ovládání pruhů

- **Osm žánrů je zapsaných, ale nehraje.** `catch`, `whack`, `defense`, `slice`, `hop`, `crowd`, `merge`, `push` (režim `default`) mají varianty schématu, `FOE_DOES` a `COUNT_PARAMS`; `compile` hází „not live“ a buňky v `compose/allowed.ts` mají stav `staged`.
- **Nový stav `staged` místo plánovaného `fallback`.** Kostra s `fallback` by u vět bez jasného slovesa stála v pořadí před běžcem a `compose()` zkouší celé pořadí – spadla by. `classifyGenre` žánry `staged` z pořadí vyřadí; úloha, která žánr pouští živě, přepne jeho buňku na `ready`.
- **Kusy os záměru** (`intent/contract.ts`) mají vlastní seznamy, ne hlavní `MOVES`/`ACTIONS`/`OBJECTIVES` – ty typují slovník sloves (kotvy a přestavba) a `action-cue/cues.ts` (soubor P54A):
  - `GENRE_MOVES`: `lanes`, `hop`, `crowd`, `drop`;
  - `GENRE_ACTIONS`: `whack`, `slice`, `merge`, `push`;
  - `GENRE_OBJECTIVES`: `defend`.
- **Ovládání** `lanes`, `hop`, `crowd`, `merge`, `push` je v `CONTROLS`, `CAPABILITIES`, `STAGES` a `CONTROL_PARAMS`. Čtení modelem nabízí jen `READ_CONTROLS` (všechna kromě `STAGED_CONTROLS` ve `spec.ts`), takže dotaz na model se nemění; úloha, která ovládání pustí živě, ho z `STAGED_CONTROLS` vyjme.
- **Pruhy** (`src/play/arcade/pieces/lanes.ts`): osa −1000..1000 → pruh 0–4 po pásmech šířky 400, šipky o pruh, `TAP` ťuk a `HOLD` držení do těla hráče (`aux0` pruh, `aux1` ťuk/tiky držení). Scéna-kostra `src/components/play/arcade/genres/lanes/LaneScene.tsx` kreslí pět pásů a kvádry těl; `lanes-input.ts` dělí plátno na pět svislých pásů (prst = ťuk a držení v pruhu, tah drží osu), šipky/A-D posunou, mezerník ťuk a držení. V `ArcadeStage.tsx` 4 řádky: import, dvouřádková větev scény (formátovač ternár nezalomí jinak) a hák vstupu. Scény `hop`, `crowd`, `merge`, `push` přidají úlohy svých žánrů.
- **Schéma režiséra se nemění – po opravě z T5.** Varianta žánru vzniká jen z režimů `ready` (`readyModes` v `director/answer-schema.ts`), ale T4 ho přesto pohnula dvěma cestami: recept odpovědi nesl nové kusy os (`recipeSchema`) a meze parametrů receptu se slučovaly i z koster (`targets` do 60, `enemies` do 80, nové `rivals`). Verze kompaktního promptu tím přešla `4ff1d2c9` → `475462bd` a `p46-fixtures.test.ts` zčervenal (nahrávky odpovědí P46 jsou z `4ff1d2c9`). Režisér teď dostává `directorRecipeSchema` (recept bez kusů nových žánrů) a meze jen z modulů, které nabízí (ne `staged`, ne `DIRECTOR_PENDING`): verze je zase `4ff1d2c9`, stejná jako na `main`, a test nahrávek ji drží. Schéma i nahrávky se přepíšou vědomě v T14, až režisér nové žánry nabídne.
- **Nic se nepohnulo:** `P54C_CHECK=1 … start.measure.ts` (věty P30 dev a živé buňky = `start.json`), replay brána, `difficulty.test.ts` (buňky `staged` se neměří; golden `freeze.ts` přeskočí žánry mimo `parameter-bounds.json`), `lanes.test.ts`.
- Modely pro P54B: `models-wanted.md`.

## T5 – Chytání (`catch`)

- **Hra.** Věci padají v pěti pruzích jako kinematická tělesa a lapací čáru (koš hrdiny, 1,2 m) protnou v jednom tiku, spočitatelném ze semínka (`landingTick`). O věci rozhoduje jen ten tik: hrdina v jejím pruhu ovoce chytí (10 bodů × kombo, čítač `items`), bombu dostane do koše (−1 život). Propadlé ovoce: první čtyři bez trestu, každé další −1 život. Výhra = chytit `items` (výchozí 30, meze 10–50), prohra = životy došly.
- **Průběh.** Po třetinách cíle padá rychleji (věc je vidět 90, 56 a 32 tiků) a hustěji (rozestup 80–110, 55–75, 38–52 tiků); bomb přibývá (25, 45, 60 % ovoce má bombu v témž tiku v jiném pruhu, polovina z nich v pruhu, kterým hráč k ovoci prochází – kdo přijde pozdě, chytí bombu). Ovoce je `items + volná + životy − 1`, takže hra vždy skončí nejpozději posledním. Cíl pod 30 natáhne rozestupy, ať hra trvá aspoň půl minuty.
- **Nečinný hráč nic nechytí:** prvních `volná + životy` kusů ovoce nepadá do startovního pruhu – nečinný přijde o životy dřív, než mu cokoli spadne do koše.
- **Kusy:** generátor a pravidla `src/play/arcade/pieces/catch-fall.ts` (`catch_fall`, `catch_goal`, kontrola „hratelné z konstrukce“ `checkCatchLevel`), robot `catch-fall-bot.ts` (jede do pruhu nejbližšího dopadu ovoce v obraze, reakce 8 tiků, bomby mine sám, protože padají vedle ovoce), modul `src/play/genre/catch.ts` (`ready`; `draftFill` čte `collect` a `avoid` z obsazení, každého jiného nepřítele hraje jako bombu a předmět „catches X“ jako ovoce), buňka `catch.default` je živá (recept přesunutý z `STAGED_PRESETS` do `PRESETS`). Svědci: `collect` (ovoce v koši), `hazard` (sonda stojí v pruhu bomby, až je vidět), pohyb `lanes` – `allowed.test.ts` dokáže všechny kusy receptu.
- **Scéna** `src/components/play/arcade/genres/catch/CatchScene.tsx`: pruhy zepředu, koruna, ze které věci padají, hrdina s košem, modely z knihovny podle popisku (výchozí jablko `cc0-apple`, bomba primitivem v barvách kitu, když model nemá). Plátnu zapíše `data-lane-edges`, podle kterých prst trefí pruh (`lanes-input.ts` je teď čte), a `data-player-x`. `LaneScene.tsx` vybírá scénu žánru podle pravidla světa (`LaneStage`); v `ArcadeStage.tsx` se změnily 2 řádky (import a větev `lanes` dostane props jako ostatní scény).
- **HUD:** pilulka postupu kitu („9/30“ s vejcem) a životy – žádný nový popisek (`collected`, `lives` v `HUD_COUNTER_LABELS` jsou).

### Měření (20 semínek)

| Brána | Výsledek |
|---|---|
| G1 robot světa | 20/20 výher, 33,0–35,0 s |
| G2 nečinný | 0/20 výher (20/20 prohra) |
| G3 `difficulty.json` | novice 10/20 = 0,50, intermediate 20/20 = 1,00, 0 chyb, 0 neshod replaye |
| G6 čítač chycených | robot 30/30 na všech semínkách, nečinný 0 |
| G4 | Node: přehrání záznamu robota = hash běhu; Chromium: záznam prstu z Pixelu 7 přehraný v Node = hash prohlížeče (`e2e/play-catch.spec.ts`) |
| G5 | 3 životy, kombo až ×5 (robot dosáhne ≥ ×3), bonus na konci, hvězdy ≥ 1 a výzva (Dare) přehraná serverem se otevře u kamaráda (e2e) |

- **E2E** (`next start` na 3321, emulace Pixel 7): `play-catch.spec.ts` 3/3 – prst vyhraje za 35,2 s se 30 chycenými, záznam prstu = hash v Node, výzva přehraná serverem se otevře u kamaráda, nečinný prohraje s 0 chycenými, scéna 17 sítí při 4× pomalejším CPU (strop 200); `p35-perf.spec.ts` 17/17, `interface-language.spec.ts` 3/3.
- **Ladění volných propadlých** (začátečník, semínka 1–20 / 1–60; intermediate a robot 1,0 všude): 2 → 0,15; 3 → 0,35 / 0,43; 4 → 0,50 / 0,57 – zvoleno 4. Rychlost poslední třetiny je hrana: věc viditelná 33 tiků místo 32 dá začátečníkovi 0,95 (dojede i přes tři pruhy).
- **Mutace (obě červené, soubor obnovený ze zálohy):** bomba v koši bez ztráty života → `catch-fall.test.ts` „a bomb in the lane takes a life“ červený; ovoce smí do startovního pruhu hned na začátku → kontrola úrovně a G1–G6 červené, a s vypnutou kontrolou úrovně G6 „idle caught: expected 1 to be 0“.
- **Nic jiného se nepohnulo:** replay brána 80/80 (7 souborů), věty P30 dev = `start.json` (`P54C_CHECK=1`), grep determinismu 6 řádků jako na startu. V `start.json` přibyla jen živá buňka `catch.default` (55 místo 54). V `difficulty.json` přibyly jen řádky `catch.default`; ostatní řádky zůstaly bajt po bajtu.

## T6 – Bouchání (`whack`)

- **Hra.** Pět děr v řadě před hrdinou. Každý cíl je kinematické tělo, které stálou rychlostí stoupá „pod zemí“, a jeho výška je hodiny okna: díra je otevřená, dokud `0 ≤ y < 7200`, tedy přesně `windowOf(vy)` tiků od tiku vykouknutí spočitatelného ze semínka. Ťuk do díry v okně (pruh z osy ťuku platí hned, hrdina za ním jen dojde) = zásah: krtek dá 10 bodů × kombo a čítač `items`, hodný cíl (zajíček) vezme život. Ťuk do prázdné díry shodí kombo (další zásah ×1). Krtek, do kterého nikdo nebouchl, se po okně schová: první dva bez trestu, každý další −1 život. Výhra = rozbít `targets` krtků (výchozí 30, meze 10–50), prohra = životy došly.
- **Průběh.** Po třetinách cíle se okno zkracuje (46–60, 32–42 a 19–28 tiků, los na krtka) a krtci chodí hustěji (rozestup 80–110, 56–76, 40–54 tiků); hodný cíl vykoukne v témž tiku jako krtek v jiné díře u 25, 40 a 55 % krtků a nejvýš čtyři krtci za sebou jsou bez něj – kdo mačká všechny díry, prohraje. V díře je naráz nejvýš jeden cíl. Krtků je `targets + 2 + životy − 1`, takže hra vždy skončí nejpozději posledním. Cíl pod 30 natáhne rozestupy.
- **Nečinný hráč** nebouchne nikdy: nic nerozbije a prohraje po pátém schovaném krtkovi (7,6–8,9 s).
- **Kusy:** generátor a pravidlo `src/play/arcade/pieces/whack.ts` (`whack_holes`, `whack_hit`, kontrola „hratelné z konstrukce“ `checkWhackLevel`; cíl hry je sdílené `catch_goal`), robot `whack-bot.ts` (bouchne do nejstaršího otevřeného krtka, který se do jeho ťuku nestihne schovat, hodné vynechá, reakce 8 tiků), modul `src/play/genre/whack.ts` (`ready`; `draftFill` čte předmět sloves whack/hit/pop/smash/squash/bonk/bop jako cíl a „but not / spare / avoid / don't hit X“ jako hodný cíl, každou jinou roli nepřítele hraje jako cíl), buňka `whack.default` je živá. Svědci: `whack` a `defeat` (krtek zasažený v okně), `hazard` (sonda bouchne do hodného cíle, až vykoukne), pohyb `lanes`.
- **Scéna** `src/components/play/arcade/genres/whack/WhackScene.tsx`: kamera za hrdinou a nad ním, díry s okrajem, kladivo nad zvolenou dírou, které ťuk spustí, cíl vyjede a zajede, zásah ho zplackne. Cíle se kreslí ze zásoby 4 slotů na druh (naráz koukají nejvýš dva), modely z knihovny podle popisku (výchozí zajíček `rigged:pet-bunny`, krtek primitivem v barvách kitu – model krtka objednává P54B). Plátnu zapíše `data-lane-edges` a `data-player-x` jako chytání. Větev v `LaneStage` (`LaneScene.tsx`), `ArcadeStage.tsx` beze změny.
- **HUD:** pilulka postupu kitu („12/30“) a životy – žádný nový popisek.

### Měření (20 semínek)

| Brána | Výsledek |
|---|---|
| G1 robot světa | 20/20 výher, 32,8–36,1 s |
| G2 nečinný | 0/20 výher (20/20 prohra, 0 rozbitých) |
| G3 `difficulty.json` | novice 10/20 = 0,50, intermediate 20/20 = 1,00, 0 chyb, 0 neshod replaye (60 semínek: 29/60 a 60/60) |
| G6 čítač rozbitých | robot 30/30 na všech semínkách se všemi životy, nečinný 0 |
| mačkání všech děr | 20/20 prohra |
| G4 | Node: přehrání záznamu robota = hash běhu; Chromium: záznam prstu z Pixelu 7 přehraný v Node = hash prohlížeče (`e2e/play-whack.spec.ts`) |
| G5 | 3 životy, kombo až ×5 (robot dosáhne ≥ ×3), bonus na konci, hvězdy ≥ 1 a výzva (Dare) přehraná serverem se otevře u kamaráda (e2e) |

- **E2E** (`next start` na 3321, emulace Pixel 7): `play-whack.spec.ts` 3/3 – prst vyhraje za 33,9 s (tik 2031) s 30 rozbitými a všemi životy, krtek je ve scéně opravdu vidět (`__playFrame`), záznam prstu = hash v Node, výzva se otevře u kamaráda, nečinný prohraje s 0 rozbitými, scéna 21 sítí při 4× pomalejším CPU (strop 200); `p35-perf.spec.ts` 17/17, `interface-language.spec.ts` 3/3.
- **Mutace (všechny červené, soubory obnovené ze zálohy):** hodný cíl bez ztráty života → 3 testy (pravidlo, mačkání, svědek `hazard`); schovaný krtek nikdy nestojí život → pravidlo kvóty a G2 (nečinný hraje do horizontu); prázdná díra neshodí kombo → test komba; ťuk platí i pod zemí → test okna; robot bouchá i hodné cíle → G1, G2/G6, G5, svědci a pásmo; kontrola úrovně pustí dva cíle do jedné díry → test kontroly.
- **Nic jiného se nepohnulo:** replay brána 80/80 (7 souborů), věty P30 dev = `start.json` (`P54C_CHECK=1`), grep determinismu 6 řádků. V `start.json` přibyla jen živá buňka `whack.default` (56). V `difficulty.json` přibyly jen řádky `whack.default` (469 řádků vložených, nic smazaného).

## Rozhodnutí

- T1: větev nese datum jako ostatní worktree (`features/P54C-nove-zanry-2026-10-19`), ne kratší jméno z plánu; stojí přímo na `origin/main`.
- T5: chytání je `ready` a jeho buňka živá, ale režisér ho do T14 nenabízí (`DIRECTOR_PENDING` v `director/answer-schema.ts`) – jinak by se vygenerovaný prompt pohnul o řádky žánru a buňky (rozpočet 15 000 B přetekl na 15 112); verze kompaktního promptu je po opravě schématu (viz T4) `4ff1d2c9`, stejná jako na `main`.
- T5: modul nemá narážky (`cues: []`) a `lanes` zůstává ve `STAGED_CONTROLS`, takže klasifikátor ani čtení modelem se nemění; věty k žánru vede až T13, proto e2e publikuje spec buňky přes `POST /api/play/games {spec}`.
- T5: meze `items` 10–50 místo 10–60 z kostry – `objective.count` ve specu unese nejvýš 50.
- T5: pilulku postupu HUD dává pravidlo `finish_collected` s cílem (HUD čte `collectNeed`, soubor P54A se neměnil); svět nemá tělo cíle, takže nevystřelí – vyhrává `catch_goal`.
- T5: oprava kostry T4 v `pieces/lanes.ts` – pruh v `aux0` je relativní ke startovnímu, protože `BodyInit` `aux0` nastavit neumí a nově postavený hráč by jinak bez vstupu odjel do pruhu 0 (test v `lanes.test.ts`); přidaný sdílený `laneOfX`.
- T5: `difficulty.json` – řádky `roam.catch` mají od P52 jiný koncový hash, než jaký je uložený (souhrn i `specHash` stejné, ověřeno na čistém T4); měření je přepíše, ale úloha je nechala bajt po bajtu a přidala jen řádky chytání.
- T5: výsledková karta arkády ukazuje u prohrané hry v pruzích „0 % of the way“ (`ArcadePlay.tsx` počítá postup z dráhy; soubor P54A) – nechané, k řešení pro vlastníka HUD.
- T5: `p46-fixtures.test.ts` (nahrané odpovědi režiséra vůči verzi kompaktního promptu) je červený už od T4 – T4 přidal hodnoty do výčtů receptu, které verze hashuje; T5 ho nemění ani neopravuje (oprava = nové nahrání odpovědí, patří k T14).
- T6: bouchání je `ready` a jeho buňka živá, ale režisér ho do T14 nenabízí (`DIRECTOR_PENDING` = chytání a bouchání); verze kompaktního promptu zůstává `4ff1d2c9` a `p46-fixtures.test.ts` je zelený.
- T6: modul nemá narážky a `lanes` zůstává ve `STAGED_CONTROLS` (klasifikátor ani čtení modelem se nemění), proto e2e publikuje spec buňky jako T5.
- T6: meze `targets` 10–50 místo 10–60 z kostry – `objective.count` ve specu unese nejvýš 50.
- T6: AC o schovaném krtkovi mlčí; zvolen trest jako u chytání (dva volné, pak život), jinak by nečinný hráč prohrál až na 90 s horizontu a pásmo začátečníka by nemělo páku.
- T6: hodný cíl vykoukne vždy vedle krtka a nejvýš čtyři krtci za sebou jsou bez něj – AC to nežádá, zavírá to výhru mačkáním všech děr.
- T6: recept buňky drží `threats: []` z T4 (hodný cíl není dokazovaná hrozba receptu); svědka `hazard` přesto dává sonda.
- T6: ťuk do prázdné díry zapíše do počítadla komba násobič 0 a další zásah má ×1 – samotné `nextMultiplier` by po ťuku dalo ×2.
- T6: pilulka postupu HUD má popisek `collected` (HUD soubor P54A zná jen ten cíl, `finish_collected` jako u chytání); viditelný text je jen „12/30“.
- T6: ovládání `lanes` v `capabilities.ts` dostalo roli a popisek `target` (krtek z popisku nese model); prompt režiséra se tím nepohnul.
- T6: svědek `hazard` bouchání se zapíše, jen když tik zásahu hodného cíle opravdu ubral život – první verze ho brala ze zmizení těla a mutace „hodný cíl bez trestu“ ho nechala zelený (svědek chytání z T5 má stejnou slabinu, nechaný beze změny).
