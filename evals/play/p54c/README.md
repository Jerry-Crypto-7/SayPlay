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

## T7 – Obrana pruhů (`defense`)

- **Hra.** Pět pruhů od hradby (2,5 m před hrdinou) k živému plotu (16 m). Nepřítel je kinematické tělo, které vyjde zpoza plotu v tiku spočitatelném ze semínka a jde stálou rychlostí k hradbě; za plotem ho jádro má, ale hráč ani robot ho nevidí. Ťuk vystřelí šíp do pruhu z osy (luk přebíjí 12 tiků, čítač `cooldown`); šíp zasáhne nejbližšího nepřítele v pruhu a ubere mu HP, nepřítel na nule padne (10 bodů × kombo, čítač `items`). Držení 0,5 s postaví v pruhu obránce (nejvýš jeden na pruh), který každých 150 tiků střelí na nepřítele blíž než 7 m od hradby. Nepřítel u hradby vezme život, boss všechny. Výhra = žádný nepřítel už nejde, prohra = životy došly.
- **Vlny.** Čtyři vlny (pro 30 nepřátel 5, 7, 8 a 10), každá rychlejší (50, 90, 130, 170 jednotek za tik – krok `waveSpeedStep` z `waves.ts` × 10), hustší a s víc nepřáteli o dvou HP (0, 20, 40, 50 %). Třetí vlna má jednu a čtvrtá dvě **dvojice útočníků**: dva nepřátelé o jednom HP vyběhnou v témže tiku ve dvou pruzích a k hradbě doběhnou za 30 tiků – robot s reakcí 8 tiků sestřelí oba, kdo reaguje o půl vteřiny později, jen prvního. Poslední je **boss** (14 HP, větší a pomalejší): finále P51 si staví generátor sám a telemetrie ho pozná (`finale.why = 'boss'`). Boss vejde nejdřív v tiku 2700; malý počet nepřátel prodlouží přestávky (240–600 tiků), teprve pak rozestupy. Pořadí běžící vlny nese čítač `WAVE_COUNTER` (`waveOf`).
- **Hratelné z konstrukce** (`checkDefenseLevel`): v pruhu se nepřátelé nedoběhnou, poslední je jediný boss, boss dojde před horizontem 90 s a sám hrdina bez obránců stihne každého s reakcí robota (rozvrh EDF nad jedním lukem). Útočníka, kterého by EDF nestihl, generátor pustí jako pěšáka jeho vlny.
- **Nečinný hráč** nevystřelí ani nepostaví obránce: první tři nepřátelé u hradby mu vezmou životy (8,3–8,9 s), nikoho nesrazí. Kdo jen postaví pět obránců a dál nic nedělá, taky prohraje.
- **Kusy:** generátor a pravidla `src/play/arcade/pieces/lane-defense.ts` (`lane_defense`; `defense_shot` – výstřel, stavba a volej obránců, čítač vlny; `defense_hit` – zásah a průlom; `defense_goal` – výhra), robot `lane-defense-bot.ts` (střílí do pruhu nepřítele s nejdřívějším průlomem, kterého šípy ve vzduchu nesrazí; v klidu – nejbližší takový průlom dál než 150 tiků – staví obránce od středu ven; reakce 8 tiků), modul `src/play/genre/defense.ts` (`ready`; `draftFill` čte „defend / protect / guard / save / hold X“ jako bráněnou věc a „from / against / stop / repel X“ jako nepřítele, každou jinou roli nepřítele hraje jako nepřítele vln), buňka `defense.default` je živá. Svědci: `shoot` (zásah šípem z luku hrdiny), `defeat` (nepřítel padl), `defend` (výhra, předmět hrad), `chaser` (sonda nestřílí, nepřítel u hradby opravdu ubral život), pohyb `lanes`.
- **Scéna** `src/components/play/arcade/genres/defense/DefenseScene.tsx`: kamera za hrdinou vysoko nad polem (vejde se řada hrdiny i plot), pruhy, živý plot, hradba s cimbuřím a dvěma věžemi, obránci (věžička s lučištníkem), šípy, kruh držení na hradbě, ukazatel HP bosse; útočníci se v běhu předklánějí. Nepřítel nese model z popisku (`cast.chaser`, výchozí goblin z katalogu), ostatní jsou primitiva v barvách kitu. Kreslí se ze zásoby slotů (8 pěšáků, boss, 5 obránců, 8 šípů). Hranice pruhů pro prst (`data-lane-edges`) jsou promítnuté uprostřed pole. Větev v `LaneStage` (`LaneScene.tsx`), `ArcadeStage.tsx` beze změny.
- **HUD:** pilulka postupu kitu („12/30“ = padlí nepřátelé) a životy – žádný nový popisek.

### Měření (20 semínek)

| Brána | Výsledek |
|---|---|
| G1 robot světa | 20/20 výher, 47,6–47,9 s; i při 10 a 50 nepřátelích (semínka 1–3) |
| G2 nečinný | 0/20 výher (20/20 prohra do 9 s, 0 sražených) |
| G3 `difficulty.json` | novice 11/20 = 0,55, intermediate 20/20 = 1,00, 0 chyb, 0 neshod replaye (60 semínek: 37/60 a 60/60) |
| G6 čítač sražených | robot 30/30 na všech semínkách se všemi životy, nečinný 0 |
| jen obránci, pak nic | 20/20 prohra |
| G4 | Node: přehrání záznamu robota = hash běhu; Chromium: záznam prstu z Pixelu 7 přehraný v Node = hash prohlížeče (`e2e/play-defense.spec.ts`) |
| G5 | 3 životy, kombo až ×5 (robot dosáhne ≥ ×3), bonus na konci, finále s bossem v telemetrii, hvězdy ≥ 1 a výzva (Dare) přehraná serverem se otevře u kamaráda (e2e) |

- **Ladění** (novice na semínkách 1–20): bez útočníků 20/20 i s hustou poslední vlnou – luk má na pěšáky dost času a reakce o 12 tiků horší nic nemění; útočníci po jednom (okno 28–34 tiků) 20/20, nejvýš jeden průlom; dvojice ve 3. a 4. vlně 0–1 + 1–3 → 15/20, 1 + 1–2 → 16/20, 1 + 2 → 10/20 (boss od tiku 2550) a 11/20 (boss od 2700, zvoleno – výhra robota pak 47,6 s místo 45,1 s, dál od meze 45 s). Robot nejdřív viděl nepřátele i za plotem (dopočítal je ze stavu) a střílel předem – opraveno a hlídá to test.
- **E2E** (`next start` na 3321, emulace Pixel 7): `play-defense.spec.ts` 3/3 – prst vyhraje za 47,9 s (tik 2871) se 30 sraženými a všemi životy, obránce postaví držením (155 tiků držení), goblin je ve scéně opravdu vidět (`__playFrame`), záznam prstu = hash v Node, výzva se otevře u kamaráda, nečinný prohraje s 0 sraženými, scéna 30 sítí při 4× pomalejším CPU (strop 200); `p35-perf.spec.ts` 17/17, `interface-language.spec.ts` 3/3.
- **Mutace (všechny červené, soubory obnovené ze zálohy):** nepřítel u hradby bez trestu → pravidlo průlomu, test obránce, pásmo a G2 (nečinný prohrál až na bossovi – G2 teď chce prohru před bossem); obránce bez stropu → test držení (dva obránci v jednom pruhu); boss u hradby bere jen jeden život → test bosse; luk bez přebíjení → test přebíjení; obránce střílí i mimo dostřel → test obránce; robot vidí za plot → test mlhy a pásmo (novice 1,0).
- **Nic jiného se nepohnulo:** replay brána 80/80 (7 souborů), věty P30 dev = `start.json` (`P54C_CHECK=1`), grep determinismu 6 řádků. V `start.json` přibyla jen živá buňka `defense.default` (57). V `difficulty.json` přibyly jen řádky `defense.default` (471 řádků vložených, nic smazaného). Cílené testy (žánry, recepty, režisér vč. `p46-fixtures`, schopnosti, pruhy, chytání, bouchání) 1561/1561.

## T8 – Krájení (`slice`)

- **Hra.** Pět pruhů, pod každým bedna. Pravidlo `slice_cut` v tiku rozpisu ze semínka vyhodí věc (efekt `spawn` z předlohy ovoce nebo bomby) ze země svisle vzhůru a dál ji nese gravitace jádra – výška v každém kroku je celé číslo spočitatelné dopředu (`heightAfter`, obdoba `ballFlight`), Rapier se nepoužívá. Ťuk do pruhu je švih: rozsekne všechno v tom pruhu, co je právě ve výšce řezu (3 m a výš). Ovoce dá 10 bodů × kombo a čítač `items`, každý kus navíc v témže švihu zvedne kombo o stupeň (ze studeného začátku ×2 a ×3); bomba ve švihu vezme život. Ovoce, které dopadne zpátky na zem, shodí kombo; první tři propadlé jsou bez trestu, každé další −1 život. Výhra = rozseknout `items` kusů (výchozí 30, meze 10–50), prohra = životy došly.
- **Průběh.** Hrsti (1–3 kusy týmž pruhem v témže tiku) chodí po třetinách hustěji (rozestup 140–175, 115–140, 90–112 tiků), létají níž (okno ve výšce řezu ~43–51, ~33–41, ~25–32 tiků) a jsou větší (dvojice 25/35/40 %, trojice 5/15/25 %). Bomby: **návnada** v jiném pruhu v témže tiku a **past** – bomba týmž pruhem o 6–10 tiků po rychlé hrsti (12, 18, 23 % hrstí): kdo hrst uvidí o 20 tiků po výhozu (reakce začátečníka), švihne, až je bomba nahoře. Nejvýš tři hrsti za sebou jsou bez bomby. Ovoce je `items + 3 + životy − 1`, takže hra skončí nejpozději posledním.
- **Hratelné z konstrukce** (`checkSliceLevel`): každá věc doletí do výšky řezu nejdřív 11 tiků po výhozu (robot ji vidí dřív), věci nelétají mezi pruhy, každou hrst robot stihne rozseknout dřív, než do jejího pruhu vletí bomba (EDF, jeden švih za tik), poslední ovoce dopadne před 90 s a ve vzduchu je naráz nejvýš tolik věcí, kolik má svět slotů (16).
- **Nečinný hráč** nešvihne: nic nerozsekne a prohraje propadlým ovocem (7,2–15,3 s). Kdo švihá do všech pruhů dokola, rozsekne bomby a prohraje na nich.
- **Kusy:** generátor a pravidlo `src/play/arcade/pieces/slice.ts` (`slice_arcs`, `slice_cut`; cíl je sdílené `catch_goal`), robot `slice-bot.ts` (švihne do pruhu s nejvíc ovocem ve výšce řezu bez bomby, polohu dopočítá z viděného stavu `heightAt`, reakce 8 tiků), modul `src/play/genre/slice.ts` (`ready`; `draftFill` čte předmět sloves slice/slash/chop/cut/split/dice jako ovoce a „but not / avoid / dodge / don't slice X“ jako bombu, každou jinou roli škůdce hraje jako bombu), buňka `slice.default` je živá (recept z T4: `lanes`, `slice`, `score`, `hazard`). Svědci: `slice` (ovoce odebrané švihem ve výšce řezu), `score`, `hazard` (sonda švihne do bomby a tik opravdu ubral život), pohyb `lanes`.
- **Scéna** `src/components/play/arcade/genres/slice/SliceScene.tsx`: pruhy zepředu, bedny, žlutá čára řezu, hrdina s čepelí, věci ze zásoby slotů (10 ovoce, 5 bomb). Jen obraz (mimo stav i hash): stopa čepele šikmo přes pruh švihu, půlky rozseknutého ovoce (meloun zelený s červenou dužinou), záblesk rozseknuté bomby, roztočení věcí. Konec věci scéna pozná sama (sloty se po zmizení znovu použijí): zmizela nebo ve slotu vyletěla nová a naposled byla nad čárou = rozseknutá. Výchozí meloun nese model `gen3d-suika`, bomba `cc0-bomb`. Plátnu zapíše `data-lane-edges` (ve výšce řezu) a `data-player-x`. Větev v `LaneStage`, `ArcadeStage.tsx` beze změny.
- **HUD:** pilulka postupu kitu („6/30“) a životy – žádný nový popisek.

### Měření (20 semínek)

| Brána | Výsledek |
|---|---|
| G1 robot světa | 20/20 výher, 32,9–45,5 s |
| G2 nečinný | 0/20 výher (20/20 prohra propadlým ovocem do 15,3 s, 0 rozseknutých, žádná bomba) |
| G3 `difficulty.json` | novice 10/20 = 0,50, intermediate 20/20 = 1,00, 0 chyb, 0 neshod replaye (60 semínek: 29/60 a 60/60) |
| G6 čítač rozseknutých | robot ≥ 30 na všech semínkách se všemi životy a bez jediné bomby, nečinný 0 |
| švihání do všech pruhů | 20/20 prohra, každý život vzala bomba |
| G4 | Node: přehrání záznamu robota = hash běhu; Chromium: záznam prstu z Pixelu 7 přehraný v Node = hash prohlížeče (`e2e/play-slice.spec.ts`) |
| G5 | 3 životy, kombo až ×5 (robot dosáhne ≥ ×3, švihy přes dva a tři kusy), bonus na konci, hvězdy ≥ 1 a výzva (Dare) přehraná serverem se otevře u kamaráda (e2e) |

- **Ladění pastí** (začátečník, semínka 1–20 / 1–60; intermediate a robot 1,0 všude): 120/160/200 ‰ → 0,70 (s kratšími rozestupy); 110/170/220 → 0,65 / 0,58; 120/180/230 → 0,50 / 0,48 (zvoleno); 130/190/240 → 0,40 / 0,43; 150/220/280 → 0,35 / 0,38. Rozestupy 120–150/96–120/76–96 dávaly robotovi 27,3 s (pod 30 s), proto o šestinu delší.
- **E2E** (`next start` na 3321, emulace Pixel 7): `play-slice.spec.ts` 3/3 – prst vyhraje za 44,0 s (tik 2637) se 30 rozseknutými a všemi životy po 20 švizích, meloun je ve scéně opravdu vidět (`__playFrame`), snímek po šestém švihu ukazuje stopu čepele a půlky melounu, záznam prstu = hash v Node, výzva se otevře u kamaráda, nečinný prohraje s 0 rozseknutými, scéna 26 sítí při 4× pomalejším CPU (strop 200); `p35-perf.spec.ts` 17/17, `interface-language.spec.ts` 3/3.
- **Mutace (všechny červené, soubory obnovené ze zálohy):** bomba ve švihu bez trestu → pravidlo bomby, švihání do všech pruhů, svědek `hazard`, pásmo; propadlé ovoce nikdy nestojí život → pravidlo kvóty a G2 (nečinný hraje do horizontu); propadlé ovoce neshodí kombo → test komba; víc kusů jedním švihem bez komba → test ×2/×3 a G5; švih platí i pod čárou řezu → 6 testů (pravidlo, G1, G2/G6, švihání, svědci, pásmo); robot švihá i do pruhu s bombou → nejdřív přežila (na generovaných úrovních robot hrst rozsekne dřív, než bomba vyletí), přidaný test s ručním světem, pak červená; kontrola úrovně nevidí bombu v pruhu hrsti → test kontroly.
- **Nic jiného se nepohnulo:** replay brána 80/80 (7 souborů), věty P30 dev = `start.json` (`P54C_CHECK=1`), grep determinismu 6 řádků. V `start.json` přibyla jen živá buňka `slice.default` (58). V `difficulty.json` přibyly jen řádky `slice.default` (471 řádků vložených, nic smazaného). Cílené testy (žánry, recepty vč. `allowed.test.ts`, režisér vč. `p46-fixtures`, schopnosti, pruhy) 1852/1852; chytání, bouchání, obrana a pruhy 65/65; krájení 23/23.

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
- T7: obrana je `ready` a její buňka živá, ale režisér ji do T14 nenabízí (`DIRECTOR_PENDING` = chytání, bouchání, obrana); verze kompaktního promptu zůstává `4ff1d2c9` a `p46-fixtures.test.ts` je zelený.
- T7: modul nemá narážky a `lanes` zůstává ve `STAGED_CONTROLS` (klasifikátor ani čtení modelem se nemění), proto e2e publikuje spec buňky jako T5 a T6.
- T7: meze `enemies` 10–50 místo 10–80 z kostry (`objective.count` unese nejvýš 50), výchozí 30.
- T7: `arena_waves` z `waves.ts` kopíruje nepřátele na místa vstupu arény s nulovou rychlostí, pochod pruhem by neuměl; vlny jsou proto předem položená kinematická těla jako u chytání a bouchání a z `waves.ts` žánr jen importuje čítač vlny (`WAVE_COUNTER`, `waveOf`) a krok rychlosti `waveSpeedStep` – `waves.ts` beze změny.
- T7: boss finále staví generátor sám (vzor míče a chytání P51 T4) a vždy, bez kontroly `genreAtLeast` – žánr nemá starší verzi než `genre.v5`; „nepřítel u hradu = život“ platí pro pěšáky, boss u hradby vezme všechny životy, jinak by šel finále obejít.
- T7: AC o tom, co obránce dělá, mlčí; zvolen lučištník, který každých 2,5 s střelí na nepřítele blíž než 7 m ve svém pruhu – je to pomoc, ne výhra (kdo jen postaví pět obránců, prohraje, test).
- T7: výhra = ubránit všechny vlny (žádný nepřítel už nejde), ne „srazit N“: prošlý nepřítel vezme život a do sražených se nepočítá, takže pilulka HUD (`collected`, soubor P54A) může na konci ukázat např. „28/30“.
- T7: AC o reakci mlčí, ale bez dvojic útočníků vyhrál začátečník 20/20 – pásmo 0,3–0,7 drží právě dvojice (páka reakce jako okno bouchání); nepřátelé jsou vidět až od plotu (16 m), robot za plot nevidí.
- T7: útočníka, kterého by sám hrdina s reakcí robota nestihl (rozvrh EDF), generátor pustí jako pěšáka – každé semínko je tak hratelné z konstrukce a měření nemá chyby stavby.
- T7: recept buňky drží tvar z T4 (`lanes`, `shoot`, `defend`, `chaser`); `shoot` dokazuje zásah šípem z luku hrdiny a efekt `hit` nese jako útočníka šíp, ne hrdinu – jinak by obecná větev svědka připsala hrdinovi i `fight`; `defend` je nový svědek výhry s předmětem hrad.
- T7: bráněná věc z věty je položka obsazení `reach` (seznam rolí obsazení jinou nemá) a role `castle` druhu `prop`; hradba je tělo `platform` bez pevnosti, kreslí se primitivem (model pro ni knihovna nemá), ovládání `lanes` v `capabilities.ts` dostalo role `chaser` a `castle` a popisek `chaser`.
- T7: kombo zvedá jen nepřítel sražený šípem hrdiny; co srazí obránce, dá holé body.
- T7: hranice pruhů pro prst promítá scéna uprostřed pole (kamera s perspektivou pruhy dál zužuje) a kamera rámuje řadu hrdiny – první verze hrdinu v krajním pruhu ořízla (snímek z e2e).
- T8: krájení je `ready` a jeho buňka živá, ale režisér ho do T14 nenabízí (`DIRECTOR_PENDING` = chytání, bouchání, obrana, krájení); verze kompaktního promptu zůstává `4ff1d2c9` a `p46-fixtures.test.ts` je zelený.
- T8: modul nemá narážky a `lanes` zůstává ve `STAGED_CONTROLS` (klasifikátor ani čtení modelem se nemění), proto e2e publikuje spec buňky jako T5–T7.
- T8: meze `items` 10–50 místo 10–60 z kostry – `objective.count` ve specu unese nejvýš 50.
- T8: věci vyhazuje pravidlo efektem `spawn` ze dvou předloh podle rozpisu v parametru pravidla (`launches`) a nese je gravitace jádra – předem položené tělo s gravitací by jádro hned posadilo na zem a nevyletělo by, kinematické tělo oblouk neumí; „balistika jako `ballFlight`“ je uzavřený vzorec `heightAfter` téže celočíselné integrace.
- T8: švih = ťuk do pruhu (pruh z osy platí hned, jako u bouchání); 2D tah jádro nemá, takže tah prstem jen posune hrdinu a `lanes-input.ts` zůstal beze změny – „směr“ švihu je jen sklon stopy čepele ve scéně (od pruhu, kde hrdina stál).
- T8: „výška řezu“ je od 3 m výš bez horní meze – všechny oblouky mají vrchol nad čárou, takže věc je k rozseknutí v jednom souvislém okně.
- T8: kombo víc kusů jedním švihem = každý kus navíc zvedne násobič série o stupeň (ze studeného začátku ×2 a ×3), všechny kusy švihu berou týž násobič.
- T8: propadlé ovoce podle AC shodí kombo a navíc po třech volných bere život (AC mlčí; jako chytání a bouchání, jinak by nečinný prohrál až na horizontu); propadlá bomba ani prázdný švih nestojí nic (AC mlčí, u bouchání prázdná díra kombo shazovala, tady AC trestá jen propad).
- T8: počet propadlých se počítá z rozpisu (vyhozené ovoce − rozseknuté − ve vzduchu), ne z čítače – sloty věcí se po zmizení znovu použijí, takže stav cíle na těle (jak to dělá chytání) by se ztratil.
- T8: pásmo začátečníka drží pasti (bomba týmž pruhem 6–10 tiků po rychlé hrsti); AC o pastech mlčí, bez nich vyhrával začátečník skoro vždy (věci jsou vidět od výhozu a okno je dlouhé).
- T8: nejvýš tři hrsti za sebou bez bomby, aby švihání do všech pruhů prohrálo (AC mlčí, jako u bouchání); hlídá to test na živé buňce, ne kontrola úrovně – hra s devíti životy by ji jinak nepostavila.
- T8: řádek se slovesem na začátku hry říká „Grab the watermelons!“, protože cíl specu je druhu `collect` (`action-cue/verb-line.ts` je soubor P54A, sloveso „slice“ tam není) – nechané pro vlastníka HUD / T14.
- T8: svědek `hazard` se zapíše, jen když tik švihu do bomby opravdu ubral život (poučení z T6/T7); kontrola bomby v robotovi se na generovaných úrovních nikdy neuplatní (hrst rozsekne dřív, než bomba vyletí), proto ji drží test s ručně položenou bombou – mutace „robot švihá i do bomby“ bez něj přežila.
- T8: výchozí meloun nese model `gen3d-suika` a bomba `cc0-bomb` (oba v knihovně); stopa čepele, půlky ovoce a záblesk bomby jsou primitiva v barvách kitu.
- T8: `difficulty.json` – vložené jen řádky `slice.default` (měření jen té buňky, ostatní řádky bajt po bajtu).
