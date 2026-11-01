# P68V – vozidla a sport (`stunt`, `minigolf`)

Pruh P68-V staví dvě nové hry ve vlastních souborech: krátký kaskadérský závod `stunt` a jednu jamku minigolfu
`minigolf`. Sdílené soubory vlastní P68-I; co pruh od nich potřebuje, je v `integration.md`.

## Kostra

Kostra P68-I T1 je v `origin/main` `15c81e6a` („P68 scaffold five games and freeze shared contracts“, #61); větev
pruhu ji sloučila 1. 11. 2026 (čekání smyčkou á 10 min, ~2 h). Jména souborů kostry = jména z plánu:

| část | `stunt` | `minigolf` |
|---|---|---|
| modul žánru | `src/play/genre/stunt.ts` (`stagedGenre`) | `src/play/genre/minigolf.ts` (`stagedGenre`) |
| jádro | `src/play/arcade/pieces/stunt.ts` (`stuntControl`, `stuntTrack` = `stunt_track`, `STUNT_RULES`) | `src/play/arcade/pieces/minigolf.ts` (`minigolfControl`, `minigolfCourse` = `minigolf_course`, `MINIGOLF_RULES`) |
| robot | `src/play/arcade/pieces/stunt-bot.ts` (`stunt_bot`) | `src/play/arcade/pieces/minigolf-bot.ts` (`minigolf_bot`) |
| scéna | `src/components/play/arcade/genres/stunt/StuntScene.tsx` | `src/components/play/arcade/genres/minigolf/MinigolfScene.tsx` |
| e2e | `e2e/play-stunt.spec.ts` (`test.skip`) | `e2e/play-minigolf.spec.ts` (`test.skip`) |
| Stage / vstup | `scene: 'stunt'`, `input: 'steer'` | `scene: 'minigolf'`, `input: 'throw-rig'` |

- Zmrazená rozhraní: `src/play/genre/p68-contract.ts` – `P68_VIEWS.stunt = ['chase']`, `minigolf = ['shoulder', 'top']`,
  `STUNT_DEBRIS_MAX = 24` (plán pruhu drží `debrisMax` 8, pod stropem), `P68_MAX_TICKS = 5400`. Herní aserce
  `evals/play/p68/assertions.json`. Brána aktivace: `ROUTE_PENDING` v klasifikátoru, `DIRECTOR_PENDING` u režiséra.
- `CONTROL_PARAMS.stunt` / `.minigolf` = `z.object({}).strict()` (zmrazené prázdné) – parametry hry jdou přes modul žánru.
- **Playwright:** kostra dopsala `play-stunt` a `play-minigolf` do `testMatch` `pixel7-touch` i `iphone-touch` –
  `playwright.p68v.config.ts` není potřeba.
- **Šev pro scénu:** `ArcadeStage.tsx` montuje `StuntScene` / `MinigolfScene` podle `stage.scene` (props `WorldProps`).
- **Šev pro dotyk:** registr `genres/touch-registry.ts` (`GENRE_TOUCH`) montuje adaptér jen hrám se vstupem `genre`
  (`railfps`, `drawsave`). `stunt` (`steer`) a `minigolf` (`throw-rig`) dostanou dotykový vstup, který `ArcadeStage`
  pro tyto vstupy už má. **Výchozí postup** pro vlastní adaptér (`StuntTouch`, `MinigolfTouch`): scéna ho vykreslí sama
  jako DOM přes `Html` / portál do kontejneru plátna; prosba o čistou montáž (registr i pro vstupy `steer` /
  `throw-rig`, nebo vstup `genre` pro tyto hry) je v `integration.md`.
- **Směrování po kostře:** snímek `route-before.json` na `15c81e6a` dává stejné rozdělení 200 vět jako `688d989d`
  před kostrou (brána aktivace drží).

## `stunt` – jádro (T2)

Soubory: `src/play/arcade/pieces/stunt.ts` (ovládání `stunt`, pravidlo `stunt_crash`, generátor `stunt_track`,
`STUNT_RULES`), `stunt-track.ts` (konstanty `STUNT`, trať, `stuntParts`, `checkStuntLevel`), `stunt-impact.ts`
(`stunt_impact`, `stunt_debris`). Testy `src/play/arcade/__tests__/stunt.test.ts`, `stunt-replay.test.ts`.
Stupeň zjednodušení **0** – trosky Rapieru s rozpočtem fungují, žebřík nebyl potřeba.

**Kdo co dělá v tiku** (hráč-auto zůstává kinematické, nikdy `FLAG.physics`; solver, tření ani podkroky se nemění):

| kus | spouštěč | co dělá |
|---|---|---|
| `stunt` (ovládání) | – | účetnictví minulého tiku (hodiny trosek, rozbité krabice → `smash`, body, zpomalení na 70 %; vzduch → `air`, `jumps`, body), pak jízda: na zemi `steerControl` (import, bez turba), ve vzduchu stálá rychlost vpřed a řízení ztlumené na ±24/tik, po nárazu 24 tiků omráčení; na rampě drží auto na ploše klínu a dává mu `vy` = `vz · h / d` (+ `GRAVITY`, kterou jádro hned odečte) |
| `stunt_crash` | kontakt | pevná překážka a ztráta rychlosti > 60 jednotek/tik (rozdíl mezi rychlostí po ovládání a po kolizi jádra) = `damage` 1 s milostí 60 tiků; první tik omráčení srazí rychlost na 40 % |
| `stunt_impact` | tik | celočíselné AABB auta proti živým krabicím hromad; zasažená hromada se **v témže tiku** celá rozletí: krabice `despawn`, na jejím místě `spawn` trosky z předlohy s rychlostí z auta + řádek tabulky rozptylu; nad rozpočet jen `despawn` |
| `stunt_debris` | tik | `despawn` trosky s hodinami na nule (HP trosky = zbylé tiky), pod `fallY` nebo za vnější hranou mantinelu |
| `finish`, `out_of_health`, `time_limit`, `score_bonus` | knihovna | cíl = výhra; životy 0 nebo limit = prohra; bonus za životy a zbylé sekundy |

**Trať (`stunt_track`):** okruh `steerPatternTrack` (vzory, bez soupeřů a turba) rozříznutý za rovinkami ≥ 16 m; do řezu
se vloží rovný úsek se středem a šířkou té rovinky – s rampou (6 m rovinka, klín 3 × 1,5 × 3,5 m, dojezd = nejdelší
skok + 10 m) nebo s hromadou (12 m před, 8 m za). Zbytek trati se posune, zatáčky zůstanou, cíl je dál na konci.
Úseky, posuny do strany a tabulka rozptylu jsou ze streamu `stunt` (`stuntRng`: `createStreams(seed).rounds.clone()`
+ `jump()` = stream, který by dostal podsystém `stunt` připsaný na konec `SUBSYSTEMS`; tabulka o další `jump()`).
Výchozí trať ~500 m: robot řízení (`steer_bot` po ose) ji projede za 1713–1883 tiků (29–31 s, 10 semínek), limit
46–50 s; nečinné auto narazí v první zatáčce a prohraje na limit (10/10).

**Čísla skoku** (`stuntFlight`, celočíselně jako jádro): při 300 j/tik 12 tiků na rampě, 41 ve vzduchu (0,7 s), dopad
15,9 m od začátku rampy, vrchol 2,5 m; při 150 j/tik 29 tiků, 8 m. Krabice 0,9 m, hromada 3–6 krabic v řadách
2+1 / 3+1 / 3+2 / 3+2+1, odraz 0,2. Troska letí `vz` = 80 % rychlosti auta ± 40, `vy` = 25 % + 10–60, do strany od
osy auta 40 + půl boční rychlosti ± 40 (j/tik); žije 150 tiků.

**Rozpočet a sloty:** živých trosek nejvýš `STUNT.debrisMax` = 8 v každém tiku (hlídá `stunt_impact`; zbytek hromady
jen zhasne); volných slotů spawnu je tolik, kolik krabic (≤ 24 = `STUNT_DEBRIS_MAX`), takže strop drží pravidlo, ne
kapacita. Fyzikálních těl naráz nejvýš počet krabic (≤ 24). Spawn bere první mrtvý slot od `spawnBase` → troska další
hromady dostane slot zhaslé trosky. `stunt_impact` je v seznamu před `stunt_debris`: slot zhaslý v tiku nevezme troska
téhož tiku (Rapier by jí nechal točení staré, `fits` drží tentýž collider).

**Nejasné body – zvolený konzervativní výklad:**
- *„pravidlo zapíše troskám vx/vy/vz“* – pravidlo jádra stav samo nemění (`contract.ts`), nový efekt „nastav rychlost“
  by byl sdílená změna. Proto hromada = krabice Rapieru od tiku 0 a náraz je vymění za trosky efektem `spawn` s rychlostí
  v témže tiku (Rapier je převezme v dalším kroku přes `create` → `teleport`). Tím je zároveň splněné „slot se znovu
  použije pro další hromadu“ – sloty krabic úrovně by se nevrátily nikdy.
- *„auto přitom zpomalí o pevný podíl“* – zpomalí ovládání v následujícím tiku (pravidlo rychlost hráče měnit nemůže);
  totéž `smash`, `impacts` a body za krabice (počítadlo ovládání, ne efekt). Rozdíl 1 tik je pod rozlišením oka.
- *Země Rapieru* je čtverec ±500 m (`physics/step.ts`): hromady jen v úsecích končících do 480 m, rampy kdekoli
  (auto fyzikální není). Trať tak může mít ~500–620 m a hra ~30 s plným plynem.
- *Skok* nemá vlastní pravidlo: ovládání vede auto po klínu a za hranou letí gravitací jádra; přistání je obyčejný
  dopad jádra (`y ≤ 0`), náraz se z něj nepočítá. Skok = aspoň 6 tiků ve vzduchu.
- *Obtížnost* bere šířku a vzory trati z řízení (`easy`/`normal`/`hard`); vlastní meze stuntu nemá.

**API pro T3 (robot, důkaz) a T4 (scéna):**
- `STUNT_BODIES` = `{ player: 0, keeper: 1, firstTemplate: 2 }`; čítače `STUNT_SLOTS` na počítadle: `air` (tiky ve vzduchu),
  `smash` (rozbité krabice), `jumps`, `impacts` (trefené hromady), pracovní `streak`, `preVx`, `preVz`, `dead`; čtení
  `stuntCounter(state, 'air')`, životy `stuntLivesOf(state)` (= čítač `health`), výsledek `outcomeOf` jádra.
- Trosky: `stuntDebrisOf(state)` (živá fyzikální těla od `spawnBase`), `isDebris`, zbylé tiky = `bodyHp`; natočení
  `unpackRotation(aux0, aux1)`. Krabice hromad = parametry `stunt_impact` (`piles[]: { first, count, template }`).
- Rampy: `world.control.params.ramps` (`{ x, z0, z1, w, h }`), `rampUnder`, `rampHeightAt`, `stuntFlight`, `stuntReach`.
- Parametry robota `stunt_bot` (vydává je generátor, robot je zatím pahýl): `topSpeed`, `course` (osa po trase rozcestí
  jako `steer_bot`, `halfWidths`), `ramps`, `firstBox`, `piles` (počty), `keeper`.
- Pravidla: `finish`, `stunt_crash`, `stunt_impact`, `stunt_debris`, `out_of_health`, `time_limit`, `score_bonus` (7 z 16).
  Efekty tiku pro scénu: `damage` (náraz do mantinelu), `despawn` + `spawn` (rozbitá hromada), `despawn` (zhasnutí).
- Konstanty `STUNT` (rychlost, rampa, hromada, vzduch, náraz, rozpočet, limit); parametry generátoru `stuntTrackParams`:
  `difficulty`, `lengthM` 200–360, `ramps` 2–4, `piles` 2–4, `boxes` 3–6, `vehicle`, `things` (1–4 modely).

**Pro P68-I (sdílené soubory, nic z toho pruh neměnil):**
- `src/sim/rng.ts`: připsat `'stunt'` na konec `SUBSYSTEMS` (za `rounds`) – `createStreams(seed).stunt` pak vydá přesně
  stream, který si jádro stuntu odvozuje samo; bez toho by další připsaný podsystém losoval totéž co stunt.
- Přednačtení Rapieru: hra má fyzikální tělesa v počátečním stavu (krabice i předlohy), `worldHasPhysics` /
  `preloadPhysics` je najdou bez úprav.
- Nový efekt ani popisek čítače hlavičky není potřeba (`smash` a `air` jsou na počítadle, popisky v `hud-labels-request.ts`).

**Mutace** (Test level full, nad commitem `0a56e155`, každá zvlášť a vrácená `git checkout`): `mutationStatus` = **5/5 zabito**.

| mutace | jak | červené testy |
|---|---|---|
| rozptyl z `Math.random` (tabulka v generátoru) | `stuntScatter` losuje mimo stream | `the same seed builds the same track and scatter table, another seed another track` |
| rozptyl z `Math.random` (za běhu v pravidle) | `kick` bere řádek tabulky s náhodným posunem | `two replays of the same record agree at every checkpoint, and with the recorded run`; `a record shifted by one tick gives another hash`; `two replays of a driven record on a generated track give the same hash and outcome` |
| impulz o tik později než kontakt | `stunt_impact` měří průnik z polohy auta o tik dřív | `the contact tick throws the pile: at least two crates move more than a metre within 30 ticks` |
| despawn bez `FLAG.alive` = 0 | `stunt_debris` vydá `stateChange` místo `despawn` | `debris go dark after debrisLife ticks (FLAG.alive = 0) and the next pile reuses the slot`; `the scenario has an impact, a despawn of the first debris and a reuse of its slot, in that order`; `two replays … agree at every checkpoint …` |
| hráč s `FLAG.physics` | ovládání hráči příznak nastaví | `the player never carries FLAG.physics and the debris budget holds from tick 0 to the end` (+ 13 dalších: auto stojí) |
| `debrisMax` nehlídaný | `stunt_impact` spawnuje bez rozpočtu | `live debris never exceed debrisMax, even with two full piles hit back to back` (12 > 8) |

## `stunt` – robot, důkaz a modul (T3)

Soubory: `src/play/arcade/pieces/stunt-bot.ts` (`stunt_bot`, `STUNT_BOT`, `STUNT_WEAK`), `stunt-trace.ts`
(`stuntEvidence`), modul `src/play/genre/stunt.ts`, výsledky `stunt-evidence.json`. Testy
`src/play/arcade/__tests__/stunt-bot.test.ts`, `src/play/genre/__tests__/stunt-module.test.ts`. Datum 1. 11. 2026 je
před milníkem stuntu (2. 11.) → stupeň zjednodušení **0**.

**Robot** jede jako robot řízení (`steerBot.decide` importem): dostane stav s předpovědí „teď“ a osu trati, ve které
je u každé rampy a hromady osou cíl. Předpověď počítá jako ovládání `stunt` (rampa, vzduch se ztlumeným řízením,
omráčení). Cíl platí od `lead` (9 m) za začátkem rovinky před úsekem s trikem do konce úseku – rovinka má osu i šířku
úseku (tak ho generátor vkládá); prvních 9 m drží skutečnou osu, jinak by ho pohled 7 m před sebe v úzkém schodu
zatáčky (šířka 3,6 m) poslal do rohu mantinelu (to byla první verze: 5/30 proher). U hromady míří na bod rozsahu
krabic nejblíž ose (stačí trefit jednu). Navíc **brzdí před ostrou zatáčkou**: schod osy ≥ 1 m do 24 tiků jízdy
a rychlost nad 240 → brzda (robot řízení sám brzdil jen na části tratí, 0 tiků na 12/30).

**Slabý robot** (`params.weak`): v předpovědi nezapočítá vlastních posledních 8 vstupů (zpoždění reakce navíc; víc
nejde – robot vidí jen stav 8 tiků starý a minulost si nepamatuje) a k ose přičte chybu ±350 ‰, která mění stranu po
50 tikách. Prohrává naráženími v úzkých schodech (3 životy). Výchozí trať: prohra 29/30. Mimo test, na kratších
tratích s náhodnými počty (délka 200–360, rampy/hromady 2–4): jen 19/30 – na širokých tratích bez úzkých schodů
slabý robot dojede. Zvětšení chyby osy ani zesílení řízení (1,5–3×) to nezměnilo; náraz do 11 m široké silnice
by chtěl chybu, která už není „slabý hráč“. Zapsáno pro P68-I (aserce `weak-loses` na zapečetěné sadě).

**Důkaz** `stuntEvidence(world, inputs)` přehraje záznam od tiku 0 a čte jen polohy těles, vstupy a hlavičku –
ne efekt `win`, čítače hry (`STUNT_SLOTS`) ani parametry pravidel: skok = ≥ 0,5 m nad povrchem (zem, nebo plocha
klínu rampy z tělesa rampy) ≥ 12 tiků za sebou; náraz = zmizelá krabice hromady (fyzikální tělo živé od tiku 0);
posunutá troska = tělo ze slotu spawnu > 1 m od místa vzniku; cíl = příď za přední hranou cíle v jeho šířce; brzda
= `DOWN` na zemi a rychlost opravdu klesla. Vrací i `hash` konce – rovná se hashi běhu robota.

**Čísla** (`stunt-evidence.json`, 10 semínek × 3 obtížnosti, výchozí trať): robot 30/30 výher za 30,4–35,0 s,
0 nárazů do mantinelu, ≥ 3 skoky (nejdelší 38–39 tiků), 3 hromady, 15 krabic pryč, 15 posunutých trosek,
≤ 15 fyzikálních těl, brzda ≥ 158 tiků; slabý 29/30 proher (9/10, 10/10, 10/10); nečinný 30/30 proher do 51 s.
Zmrazené aserce P68-I (`assertions.json`): `bot-wins`, `idle-loses`, `crosses-finish`, `one-jump`, `debris-hit`
splněné 30/30; `weak-loses` 29/30 (prah plánu 8/10 na obtížnost splněný). Publikační brána (`compileArcade`
+ `verifyArcade`) na semínkách 1–10: 10/10 publikovatelných. Na kratších tratích s náhodnými počty robot 30/30 bez
nárazu (průzkum, mimo test).

**Pin** (`stunt-bot.test.ts`): laboratorní trať s rampou a hromadou stranou osy – řidič po ose vyhraje, ale důkaz
ukáže 0 skoků a 0 hromad; robot na téže trati skočí i trefí. Svět bez pravidla `finish`: běh prohraje a důkaz přesto
hlásí průjezd cílem (cíl z polohy, ne z výhry).

**Modul** `stunt.ts`: `compileStunt` (spec → `control: 'stunt'`, `controlParams: { generator: 'stunt_track',
tuning: { vehicle, difficulty?, lengthM?, ramps?, piles? } }`, role `pile` (`target`, věc z věty) a `finish`
(`exit`), 3 životy, `theme.look` z `lookFor`), `paramBounds` (rampy 2–4, hromady 2–4, `lengthM` 200–360,
`difficulty` 1–3 = easy/normal/hard), `draftFill` (vozidlo = slovo vozidla s ≤ 2 slovy před ním → `modelOf`; věc
hromad z „a tower of …“ / „smashes through …“; místo za poslední předložkou místa), `cues` jako seznam (bez „race“,
„drive“, „drift“).

**Nejasné body – zvolený konzervativní výklad:**
- *Viditelnost a `p68-staged.test.ts`.* Blok „a skeleton does not compile“ chce, aby `compile` modulu v registru
  házel. Plán dovoluje blok ve větvi smazat, brief úlohy ale sdílený test měnit zakazuje (a `owned-paths` by cestu
  odmítl) → kostra zůstává: `stuntGenre` v registru = narážky, meze a návrh hotové hry, ale `staged` a `compile` hází;
  hotový modul je `stuntLiveGenre` (`compile: compileStunt`, `ready`). Zapojení = `stuntGenre = stuntLiveGenre`.
- *Věc hromad ve specu.* `tuning` nese jen čísla, booleany a krátké řetězce, generátor chce pole `things` → hromady
  zůstávají model `crate`; věc z věty nese popisek role `pile`, ze kterého ji scéna (T4) může kreslit.
  Čistší cesta: skalární klíč `thing` v `stuntTrackParams` (`stunt-track.ts`, soubor pruhu, mimo soubory T3).
- *Kompilace specu přidá hře pravidlo `hooks` (1 kolo, `genre.v7`) a druhé `score_bonus` (`scoring: {}`
  z `legacySpec`)* – sdílená cesta všech žánrů; robot, brána ani důkaz to nemění, ponecháno.
- *Přednačtení Rapieru* – oprava zápisu T2: `preloadPhysics` rozhoduje podle specu (`specNeedsPhysics`: `ball`,
  `merge`, `push`, věci s fyzikou), ne podle světa; `stunt` tam není. Publikace (`_publish.ts`) Rapier načítá už při
  importu modulu, takže to obvykle projde, ale první požadavek po startu serveru může dostat `PHYSICS_NOT_LOADED`
  (422 `WORLD_REJECTED`). Prosba do `integration.md`.

**Pro T5 (e2e):** tělo `POST /api/play/games` = `{ "spec": <fixture.spec>, "seed": 1 }` ze `stunt-evidence.json`
(test drží, že je to přesně překlad modulu a projde branou; projde na semínkách 1–10). Vstup `steer`: osa / šipky
řídí, `DOWN` brzdí, plyn je automatický. `botWants()` sondy `__playShell` vrací rozhodnutí `stunt_bot` (reakce
8 tiků, ruka robota světa). Čítače hry na počítadle (tělo 1):
`air` (tiky ve vzduchu), `smash` (rozbité krabice), `jumps`, `impacts` (`stuntCounter`). Pro jistotu proti
`PHYSICS_NOT_LOADED` jeden opakovaný POST, nebo zahřátí serveru požadavkem dřív.

## `stunt` – scéna, kamera a palec (T4)

Soubory v `src/components/play/arcade/genres/stunt/`: `StuntScene.tsx` (scéna), `stunt-camera.ts` (póza kamery),
`stunt-fx.ts` (jiskry a prach), `stunt-touch.ts` (gesto → `ArcadeInput`), `StuntTouch.tsx` (palec a počítadla jako DOM).
Testy `__tests__/stunt-camera.test.ts`, `__tests__/stunt-touch.test.ts`.

**Scéna.** Silnici, zem, kulisy a orientační bod kreslí `SteerBackdrop` závodu (import) z mantinelů světa a sady místa
(`theme.look`). Rampy jsou **procedurální klíny** přesně podle jádra (výška 0 na `z0`, `h` na hraně `z1`): model
`gen3d-ramp` je prkno na podpěře 0,84 × 1 × 2 m bez natahovatelných os; vepsaný do klínu 3 × 1,5 × 3,5 m by byl o polovinu
užší než plocha, po které jádro auto vede, a směr stoupání modelu se bez prohlížeče ověřit nedá. Barva klínu = `look.block`
sady, bez ní `sun` / `sun-deep`. Krabice hromad a trosky kreslí poloha a natočení ze stavu (`unpackRotation`, x zrcadlené
jako `MergeScene`), model = druh těla (věc z věty z katalogu); slot trosky má model každé předlohy hry a ukáže ten svůj.
Cíl = brána ze sloupů a slunečného pásu na místě těla `goal`. Vozidlo = druh hráče z generátoru (`stunt_track.vehicle`);
výchozí `car` není model katalogu, pak hrdina obsazení (`cast.player`, u závodu `race-car`). Hodiny relace jdou v `useFrame`
s prioritou −2, takže auto, trosky, jiskry i kamera čtou týž tik.

**Kamera** `stuntCameraPose(state, aspect, rect, { prev, alpha, road, fov, reduced })` – čistá, bez `window`:
- na šířku vlastní póza 2,9 m nad zemí a 6,8 m za autem, míří 11 m před auto na osu trati (`stripCurve` nad `roadShapeOf`);
  `rect` se nečte;
- na výšku nižší a bližší póza (3,2 m, 5,6 m), pak `fitTall` (`portrait-frame.ts`) s krabicí auto + 30 m osy trati před ním
  (± 1 m); bod pohledu jede s kamerou o týž vektor. Na 412 × 839 s pásy 110 / 680 px má auto 18 % výšky plátna (strop
  čitelnosti `LegibleBodies` 2× ho dotáhne na 20 %);
- ve vzduchu kamera stoupá s autem a o 0,5 m navíc na metr výšky, bod pohledu o 0,6 m na metr (výška auta je spojitá
  balistika jádra, takže plynule);
- po nárazu (milost `stunt_crash`) tlumený otřes 15 tiků, nejvýš 0,2 m, směr z tiků milosti; `prefers-reduced-motion`
  (`reducedMotion()` z `effects/feel.ts` čte scéna, ne funkce) ho vypne. Sdílený otřes `Effects` (0,14 m, 9 tiků po zásahu
  hráče) jede dál navrch – vypnout ho bez sdílené změny nejde, přesah je 150 ms.

**Odezva nárazu** `stunt-fx.ts`: vlastní sběrnice `createEffectsBus` (jen poslouchá relaci) → zásah hráče = 10 jisker,
nová troska (rozbitá hromada) a dopad = 3 prachu na událost; nejvýš 24 částic naráz (nová dávka vytlačí nejstarší), dvě
sítě instancí. Směry z tiku a pořadí, žádná náhoda. Záblesk, úlomky a obláček sdílené vrstvy zůstávají vedle.

**Palec – šev a dvojí vstup.** `ArcadeStage` dává vstupu `steer` `useSteerInput`: nativní posluchače ukazatele na **celé**
ploše hry (první prst = tah, druhý kdekoli = brzda) a klávesy (šipky / A-D s volantem `key-steer`, S / ↓ brzda).
`StuntTouch` je proto DOM vrstva v ploše hry (vlastní kořen `createRoot` v kontejneru `stunt-overlay`, montuje ji
`StuntScene` při `enabled`): plocha přes spodní polovinu scény a tlačítko brzdy **zastaví** svůj ukazatel
(`stopPropagation` v nativním posluchači, jako `ActionButton`), takže týž prst neřídí dvakrát; klávesnici dál drží
`useSteerInput`, v horní polovině scény řídí prst jeho tah (tatáž sémantika). Pohyb myši bez stisku se nečte (jinak by
přepsal osu kláves). Okrajový případ: prst nahoře a palec dole naráz si `session.hold` přepisují – kdo se hnul naposled.
Gesto: tah od místa stisku, mrtvá zóna 12 px, plná osa od 90 px (jako `DRAG_PX`); brzda = `BUTTON.DOWN`, dokud se drží;
řídí první prst na ploše, prst na brzdě nikdy. Výsledek je tentýž `ArcadeInput` jako šipky a S / ↓ (test proti
`driveInput`). Tlačítko `sp-btn sp-btn--primary play-fire` = jediná rajčatová akce, kolo palce 72 px na `--_stack`
vpravo dole (≥ `--sp-size-touch-min`, ve spodních 45 %); třída `.play-fire` ho započítá do dolního pásu `playRect`.

**Počítadla.** HUD (`ArcadePlay.hudCountersOf`, sdílený) čítače z počítadla hry nezná, bez sdílené změny je neukáže.
Scéna proto kreslí vlastní pilulku vlevo dole (`sp-hud-pill`, `pointer-events: none`): `Smash` = `stuntCounter('smash')`
(rozbité krabice), `Air` = `stuntCounter('jumps')` (skoky, `hud-labels-request.ts`: „tiky ve vzduchu přepočtené na skoky“).

**Pro T5 (e2e):**
- DOM: plocha palce `[data-testid="stunt-touch"]` (spodní polovina scény, `data-axis` = osa, kterou adaptér drží), brzda
  `[data-testid="stunt-brake"]` (třída `is-pressed`, když drží), počítadla `hud-counter-smash` / `hud-counter-air`
  s `data-count` v `[data-testid="stunt-counters"]`, vše v `[data-testid="stunt-overlay"]`; `arcade-stage` má
  `data-player-x` (auto na obrazovce −1…1).
- Prst podle `botWants`: osa `a` = tah o `stuntDragPx(a)` px od místa stisku (`stunt-touch.ts`), `BUTTON.DOWN` = držet
  `stunt-brake`; osa 0 = prst pustit (nebo vrátit na místo stisku).
- Desktop: šipky / A-D a S / ↓ (`useSteerInput`, beze změny).

**Pro P68-I (sdílené soubory, nic z toho T4 neměnil):**
- Čistá montáž palce (prosba už je v `integration.md`): až `GENRE_TOUCH` vykreslí `StuntTouch` (props = `GenreTouchProps`),
  smazat `<StuntTouch>` ze `StageOverlay` ve `StuntScene.tsx` – jinak bude palec dvakrát.
- Až HUD ukáže `smash` a `air` sám, smazat `<StuntCounters>` ze `StageOverlay`.
- `FreshCamera` (`feed/StageHost.tsx`) nevrací `setViewOffset`, který na výšku nechává `SurvivorScene`; `StuntScene` ho
  proto sama ruší (`clearViewOffset`). Oprava patří do `FreshCamera`.

**Testy (pin):** kamera – na 412 × 839 leží auto i 30 m osy trati v hracím obdélníku na 5 tratích (všechny obtížnosti) po
7 m, uprostřed i u obou mantinelů, na zemi i 4 m ve vzduchu; auto ≥ `LEGIBLE_SHARE.hero / LEGIBLE_CAP`; na šířku póza
nezávislá na `rect`; ve vzduchu výš; otřes po nárazu, bez něj při reduced motion a po 15 tikách. Palec – plný tah a brzda
= šipky / A-D a S / ↓, mrtvá zóna = osa 0, `stuntDragPx` je opak `stuntAxis`, druhý prst ani prst na brzdě neřídí.
Rozbito schválně (vráceno ze zálohy): kamera na výšku bez `fitTall` → červený test obdélníku; otřes bez `reduced` →
červený test otřesu; `air.lift` 0 → červený test výšky. Krabice bez 30 m trati test obdélníku nezčervená (trať je v záběru
i tak, krabice mění jen velikost auta 18 % vs. 16 %) – zůstává podle plánu.

## `minigolf` – jádro a spike (T6)

**Rozhodnutí: celočíselné kutálení v jádře = stupeň 1 žebříku zjednodušení `minigolf`.** Koule Rapieru se útlumem
nezastaví spolehlivě. Datum 1. 11. 2026, před milníkem – stupeň zvolila čísla spiku, ne kalendář.

### Spike (1. 11. 2026)

Rovná chodba 3,6–4 m s mantinely, 50 ran: síla (nabití) 15 / 35 / 60 střídavě, směr osou −400…400, každá rána
přehraná dvakrát od tiku 0. „Stojí" = poloha se už nepohne; limit `MINIGOLF.stopTicks` = 180 tiků (3 s).

| varianta | nabití | stojí do 180 tiků | nestojí ani za 600 | medián / max tiků do klidu | odraz od mantinelu | přehrání shodná |
|---|---|---|---|---|---|---|
| koule Rapieru + útlum 2 j/tik ve stavu | 15 | 17/17 | 0 | 142 / 147 | 0 | 50/50 |
|  | 35 | 4/17 | 8 | 181 / 185 | 8 | |
|  | 60 | 0/16 | 12 | 231 / 231 | 12 | |
| celočíselné kutálení (`minigolf-roll.ts`) | 15 | 17/17 | 0 | 25 / 29 | 0 | 50/50 |
|  | 35 | 17/17 | 0 | 53 / 69 | 12 | |
|  | 60 | 16/16 | 0 | 98 / 119 | 12 (2 přeskočily mantinel = mimo dráhu) | |

Proč Rapier neprošel: útlum přepíše jen lineární rychlost, rotace koule zůstane a tření ji vrací do pohybu – koule
po „zastavení" dál leze (24–310 tiků) a míček s odrazem se do 600 tiků nezastaví vůbec. Rána s nabitím 60 navíc
skončí v průměru ~6,7 m od odpaliště místo 14,5 m (skluz před valením, odrazy). Celočíselné kutálení zastaví každou ránu, střed míčku nikdy nepřejde
vnitřní líc mantinelu (max |x| = 1800) a fyzika Rapieru se pro minigolf vůbec nenačítá. Skripty spiku jsou mimo repo
(`D:/caches/p68/v/t6-spike-*.test.ts.txt`, čísla `t6-spike-*.json`).

### Jádro

- **`pieces/minigolf-roll.ts`** – čisté celočíselné funkce, které sdílí ovládání, robot i scéna: `MINIGOLF` (konstanty),
  `minigolfAim(axis)` (osa → směr jako bod na obvodu čtverce, žádná trigonometrie: 0 = +z, +500 = +x, ±1000 = −z),
  `minigolfAxisToward(dx, dz)` (opak), `minigolfSpeed(charge)` = `ballSpeed(charge) − BALL.minSpeed` (4–240 j/tik),
  `minigolfShot`, `minigolfDamp` (rychlost −2 j/tik se stejným směrem, ≤ 2 = stojí), `minigolfRoll` (tik: podkroky
  ≤ 100 j, vytlačení po ose menšího průniku, odraz kolmé složky 700 ‰ mantinel / 800 ‰ odrazník, kolmá rychlost
  > 180 = přeskok mantinelu), `minigolfDistance(charge)` = 4·charge² + 2·charge (uzavřený vzorec rány po ose),
  `minigolfRest(axis, charge)` (přesný klid na volné ploše) a `minigolfChargeFor(axis, distance)`.
- **`pieces/minigolf-hole.ts`** – generátor ze streamu `minigolf` (`createStreams(seed).rounds` + 2× `jump()`, mimo
  všechny `SUBSYSTEMS`): dlaždice 4 × 4 m, tvar rovná (3–4 dlaždice) / L (3 + 2–3 vlevo či vpravo) / S (3 + 2 napříč +
  2–3), mantinely na volných hranách, odpaliště vzadu první dlaždice, jamka (Ø 1 m) v poslední, 1–3 odrazníky mimo
  trasu, nejvýš jedna pohyblivá překážka (kinematická, kyvadlo jádra, rozsah 2 m, rychlost 25/40/50 → perioda 80/50/40
  tiků) v prostřední dlaždici úseku. Par = úseky trasy + 1: rovná 2, L 3, S 4. `checkMinigolfHole(level, layout)`
  ověří: trasa končí ve středu jamky; z odpaliště a z každého bodu vede k dalšímu volná přímka v pásu 0,35 m od mantinelů
  a odrazníků; pohyblivá překážka ji pustí aspoň v jedné krajní poloze; každý úsek ujede jedna rána (≤ 14,02 m); body
  trasy leží na dráze; nic nezakrývá jamku.
- **`pieces/minigolf.ts`** – ovládání `minigolf`, pravidlo `minigolf_hole`, generátor `minigolf_course` (jména kostry).
  Hráč **je** míček. Rána jen když míček stojí; mimo dráhu = míček zpět na místo poslední rány + 1 rána; v jamce =
  střed v kruhu jamky a rychlost ≤ 60 j/tik (rychlejší přeletí); výhra = v jamce do limitu ran (par + 3), skóre
  `100 × (limit + 1 − rány)`; prohra = stojící míček po vyčerpání ran, nebo poslední tik horizontu 90 s.

### Výklad nejasností (konzervativně)

- **Směr je absolutní a drží se ve stavu** (`aux0` hráče), aby kamera T8 měla směr ze stavu: tik s `HOLD` nebo `TAP`
  ho vždy přepíše osou (i nulou = +z), jiný tik jen nenulovou osou. Vstup tedy musí s nabíjením nést osu jako
  `ball-input` (`session.hold(axis)` + `HOLD`, puštění `press(TAP, axis)`). Vstup `throw-rig` ve VR posílá `HOLD` bez
  osy – míření ve VR by potřebovalo paprsek (VR minigolf není v plánu P68V).
- **Puštění za pohybu** ránu nedá a nabití zahodí (měřič se vyprázdní); nabíjet za pohybu jde.
- **Mimo dráhu** vzniká přeskokem mantinelu (kolmá rychlost > 180 j/tik; plná rána kolmo je 240): skutečný jev
  minigolfu a jediná cesta ven z ohrazené dráhy. Střed míčku mimo dlaždice → pravidlo vydá `respawn`.
- **Trasa robota** je v parametrech světa (`layout.route`, i v parametrech robota), ne jako těla: úroveň nemá volné
  pole a mrtvá těla by se pletla scéně i katalogu modelů. Body trasy jsou mezicíle (rohy dráhy, pak jamka), ne odrazy.
- **Pohyblivá překážka jen na přání** (`moving: true`); tvar a počet odrazníků bez parametru losuje stream.
- **Všechna těla hřiště jsou nepevná** (`solid: false`) – srážky míčku řeší jen `minigolfRoll`, jádro žádnou nepřidá
  a nezruší odraz. Dlaždice leží pod zemí (y −100…0), jamka taky, takže ani nevyvolají kontakt.

### API pro T7 (robot) a T8 (scéna)

- Rozložení: `layout` v parametrech ovládání, pravidla i robota (`MinigolfLayout`): `hole` (index), `floor`, `rails`,
  `bumpers` (`[první, počet]`), `mover?` (index), `route` (`[x, z][]`, 1–3 body, poslední = střed jamky).
- Stav: míček = hráč (`x/z`, `vx/vz` = rychlost příštího tiku, klid = obě 0); míření `aux0` (osa), nabití `aux1`
  (0–60); místo poslední rány `HEADER.respawnX/Z`; čítače `MINIGOLF_COUNTER` – rány `ammo`, par `reserve`, návraty
  z mimo dráhy `items` (`strokesOf`, `parOf`, `outOfBoundsOf`); skóre `score` jen při výhře.
- Síla: nabití = počet tiků `HOLD`; `minigolfChargeFor(axis, vzdálenost)` vrátí nejmenší nabití, které dojede
  (přesně jako hra), `minigolfDistance(charge)` je uzavřený vzorec po ose. Pohyblivá překážka:
  `minigolfMoverAt(mover, tick)` = její poloha v tiku (kyvadlo jádra), `minigolfRoll` dovolí robotu ránu přehrát
  i s překážkami.

### Pro P68-I (sdílené soubory – nic se neměnilo)

- **Přednačtení fyziky není potřeba:** svět minigolfu nemá těleso `FLAG.physics`, Rapier se nenačítá.
- HUD `Strokes` / `Par` čtou čítače `ammo` / `reserve` (popisky už v `hud-labels-request.ts`).
- Druhy `minigolf-hole`, `minigolf-green`, `minigolf-rail` nejsou modely katalogu – kreslí je scéna T8 procedurálně.

### Testy

`src/play/arcade/__tests__/minigolf.test.ts` (16) a `minigolf-replay.test.ts` (3): týž seed = táž jamka, 30 seedů =
≥ 29 různých; `checkMinigolfHole` na 200 seedech a na všech tvarech × 1–3 odrazníky × s/bez pohyblivé (12 seedů);
kontrola chytí zablokovanou trasu, trasu mimo jamku, dlouhý úsek a překážku, která nikdy neuhne; rána ve směru osy
zastaví do `stopTicks` přesně tam, kam říká `minigolfRest`; plná rána 14 520 j za 120 tiků; odraz od mantinelu; rychlý
míček jamku přeletí, pomalý spadne; puštění za pohybu nic nezmění; přeskok mantinelu vrátí míček a přičte ránu;
prohra vyčerpáním ran i časem; pohyblivá překážka sedí na `minigolfMoverAt` a míček odrazí bez průniku; replay od
tiku 0 dvakrát týž hash a shodné kontrolní body po každé ráně i po návratu z mimo dráhy; posun o tik = jiný hash.

### Rozbito schválně (`mutationStatus`: 4/4 červené, 1. 11. 2026 na `b3514033`)

| mutace | kde | červený test |
|---|---|---|
| útlum z plovoucí čárky bez zaokrouhlení | `minigolfDamp` bez `Math.trunc` | `damps in integers and always slows down`; `rolls the ball the way the axis points and rests within stopTicks exactly where the roll formula says` |
| rána povolená za pohybu | ovládání: podmínka klidu vždy pravdivá | `ignores a release while the ball still rolls: no stroke, the roll goes on unchanged` |
| jamka bez prahu rychlosti | `minigolf_hole`: rychlost se nekontroluje | `rolls a fast ball over the hole and drops a slow one in` |
| pohyblivá překážka podle wall-clocku | `minigolfMoverAt` z `Date.now()` místo tiku | `moves in ticks along its period, as the closed form says` |

Pohyb překážky v hashovaném stavu dělá kyvadlo jádra (`kernel.ts`, sdílené, jen tiky); wall-clock by mohl zabloudit jen
do předpovědi `minigolfMoverAt`, kterou čeká robot T7 a scéna T8 – test ji drží na stavu jádra tik po tiku.

## `minigolf` – robot, důkaz a modul (T7)

Datum 1. 11. 2026 (`date +%F`), před milníkem 3. 11. – stupeň zjednodušení zůstává **1** (celočíselné kutálení z T6).
Soubory: `pieces/minigolf-bot.ts` (`minigolf_bot`), `pieces/minigolf-trace.ts` (`minigolfEvidence`), modul
`src/play/genre/minigolf.ts`, testy `arcade/__tests__/minigolf-bot.test.ts` (10), `genre/__tests__/minigolf-module.test.ts`
(6), výsledky `minigolf-evidence.json` (test ho přepočítá a porovná).

**Robot** hraje jen vstupem: `HOLD` s osou × nabití tiků, pak `TAP` s toutéž osou; reakce 8 tiků (nabití = `aux1`
ve stavu + `HOLD` z `recent`, `TAP` v `recent` = rána letí).
- *Kam:* z místa, kde míček stojí, zkusí body trasy od jamky zpět a vezme první, kam rána podle `minigolfRoll`
  (mantinely a odrazníky, čistá funkce jádra) opravdu dojede – jamka: míček v jamce (zkusí i nabití ±1); roh: zastaví do
  0,7 m bez nárazu. Míček mimo trasu (slabý robot, náraz) → bod s nejvyšším indexem, ke kterému se rána aspoň o polovinu
  přiblíží.
- *Síla:* uzavřený vzorec `4c² + 2c` obrácený na nejmenší `c`, opravený přesným `minigolfRest` o šikmou ránu.
- *Míření se stáčením:* celočíselný útlum (`Math.trunc` složek) ubírá menší složce rychlosti relativně víc, takže
  dlouhá šikmá rána se stočí k ose – 7,6 m rána minula jamku o 0,8 m. `minigolfAimAt` proto osu opraví o úhel, o který se
  klid rány minul s cílem (nejvýš 6 kroků). Bez opravy robot na S prohrával (2/10 seedů).
- *Pohyblivá překážka:* robot čeká na první tik puštění (do 2 period kyvadla), kdy stojící míček během nabíjení i celá
  rána překážku minou – hrubé síto odstupem, pak kutálení s překážkou v poloze `minigolfMoverAt` (ukotvené na viděný stav)
  musí dát přesně dráhu bez ní. Bez okna hraje hned.

**Slabý robot** = týž robot s `MINIGOLF_BOT.weak` (`aimError` 120 jednotek osy ≈ 13–27°, `powerPct` 60 % nabití) –
krátké rány vedle, vyčerpá limit ran. **Nečinný** hráč prohraje na posledním tiku 90 s.

**Důkaz** `minigolfEvidence(world, inputs)` přehraje záznam od tiku 0 a čte jen stav po každém tiku: `strokes` (čítač),
`shots` (tiky s `TAP`), `aimChanges` (`aux0` se změnil), `chargeTicks` (`aux1` rostl), `bounces` (rychlost po tiku ≠
samotný útlum), `outOfBounds`, `holed` (střed míčku v kruhu jamky a rychlost ≤ `holeSpeed` na konci), `outcome`, `ticks`.

| 10 seedů × | robot vyhrál (rány) | slabý prohrál vyčerpáním ran | nečinný prohrál časem |
|---|---|---|---|
| lehká: rovná, 1 odrazník | 10/10 (1 = jamka na ránu, par 2) | 10/10 | 10/10 |
| střední: L, 2 odrazníky, pohyblivá | 10/10 (2, par 3) | 10/10 | 10/10 |
| těžká: S, 3 odrazníky, pohyblivá | 10/10 (3, par 4) | 10/10 | 10/10 |

Zmrazené aserce P68 (`evals/play/p68/assertions.json`) na 30 jamkách: `bot-wins`, `idle-loses`, `weak-loses`,
`ball-in-hole`, `strokes-counted` – všechny **30/30**. Publikační brána (`compileArcade` + `verifyArcade`, jako
`POST /api/play/games`) projde vzorovým specem na 10/10 seedech a každou z 10 dev vět.

**Výklad nejasností (konzervativně):**
- *„Obtížnost“* minigolf nemá; tři obtížnosti testu = tvar a překážky (tabulka výš).
- *„Jamka s odrazem“* = jamka, jejíž trasa zatáčí (L, S – T6 body trasy původně nazýval „body odrazu“): tam robot
  přemíří v každém rohu (`aimChanges ≥ úseky − 1`). Robot světa se na vygenerovaných jamkách neodráží nikdy (úseky trasy
  jsou volné konstrukcí a do pohyblivé překážky nenarazí – `bounces` 0 na 20 jamkách s ní); čítač `bounces` drží test se
  ručním odrazem od mantinelu a slabý robot (odrazy na 19/30 jamkách). Čekání drží test „slepý“ robot: týž robot bez
  překážky v parametrech do ní aspoň jednou narazí.
- *„Míček skončí v jamce“* (`ball-in-hole`) = střed v kruhu jamky a rychlost do `holeSpeed`; výhra běh ukončí, míček
  „spadl“. *`strokes-counted`* = čítač ran = počet `TAP` v záznamu (robot nepouští za pohybu a nevyletí z dráhy).
- *Modul zůstává `staged`* a jeho `compile` hází jako kostra (`p68-staged.test.ts`, blok „a skeleton does not compile“);
  skutečný překlad je `compileMinigolf`, `compile` ho zavolá, jakmile `availability` vrátí `ready` – zapojení přepne jen
  tenhle řádek. Narážky jsou v `cues` (klasifikátor je nečte díky `ROUTE_PENDING`; `routing-guard` zelený).
- *Hrdina* je vždy míček (`golf ball`); věci z věty jsou překážky, věc, kterou věta hýbe („spinning windmill“,
  „sliding snake“, „moving coffin“), je pohyblivá překážka (`patrol` v obsazení → `moving`). Jádro bere jeden model
  odrazníků a jeden pohyblivé překážky: odrazníky dostanou model první věci, kterou katalog zná (`sceneModelOf`).

**Pro T8 (scéna, natažení):** šikmá rána se na dlouhé dráze stáčí k ose (výš) – stopa míření, která má ukázat, kam
míček dojede, ji spočítá přesně `minigolfRest(osa, nabití)`; míření prstem na jamku bez opravy bude u dlouhých šikmých
ran o kus vedle. `minigolfAimAt(dx, dz)` vrátí osu a nabití, které na bod opravdu dojedou.

**Pro T9 (e2e):** vstup = `session.hold(axis)` + `HOLD` po `charge` tiků, pak `press(TAP, axis)`; `botWants` sondy dá
přesně tohle (robot světa `minigolf_bot`, reakce 8). Počítadla: rány `ammo` → `Strokes`, par `reserve` → `Par`.
Robot dá rovnou jamku na 1 ránu, L na 2, S na 3 (pod par); běh trvá 2–8 s. Vzorový spec pro
`e2e/fixtures/p68-minigolf-spec.json` (dráha L, 3 odrazníky-dýně, pohyblivá rakev; brána 10/10 seedů) = `SAMPLE`
v `minigolf-module.test.ts` = `compileMinigolf` věty „mini golf in a haunted house with pumpkins and a moving coffin“
s `bends: 1, obstacles: 3`:
`{"control":"minigolf","controlParams":{"generator":"minigolf_course","tuning":{"shape":"L","obstacles":3,"moving":true,"bumper":"cc0-pumpkin","mover":"gen3d-coffin"}},"genre":{"id":"minigolf","mode":"default","compilerVersion":"genre.v7"}, …}`
(celý v testu; `scoring: {}`, `mechanics: []`, role `player` `golf ball`, `hole`, `bumper`, `mover`).

**Rozbito schválně:** úroveň testu `pin`, `mutationStatus` = none. Čekání na překážku drží test se „slepým“ robotem;
bez opravy míření robot při ladění prohrál na S 2/10 – test výhry 30/30 by to chytil.

## `minigolf` – scéna, kamera a natažení (T8)

Soubory v `src/components/play/arcade/genres/minigolf/`: `MinigolfScene.tsx` (scéna), `minigolf-camera.ts` (čistá
kamera), `minigolf-touch.ts` (čisté gesto → `ArcadeInput`), `MinigolfTouch.tsx` (DOM vrstva natažení a klávesnice),
testy `__tests__/minigolf-camera.test.ts` (5) a `minigolf-touch.test.ts` (8).

### Scéna

- Dráha z těl úrovně: dlaždice = trávník (`colorHex.grass`), mantinely (`cream-deep`), jamka procedurálně (černý
  kalíšek Ø 1 m s okrajem) a v ní vlajka `finish-flag`; odrazníky a pohyblivá překážka přes `modelIdOf` (model druhu
  těla – výchozí `tire-barrier` / `crate`, popisky rolí `barrier` / `obstacle`, druh z věty od T7) na tmavém soklu
  v půdorysu těla (kde se míček opravdu odrazí). Povrch, kulisy a horizont sady (`FieldGround`, `Scenery`,
  `HorizonBackdrop`). Míček kreslí model svého druhu (`gen3d-golf-ball`), ne hrdinu věty (`cast.player`).
- x jádra se zrcadlí jako v aréně: kladná osa míří na obrazovce doprava. Míček se valí (natočení podle ujeté dráhy),
  po výhře sedí v kalíšku. Stopa míření = 10 teček na trávníku ve směru `aux0`, délka 1,2 m bez nabití, s nabitím
  dojezd rány (`minigolfDistance`) do 5 m; jen když míček stojí. Sonda záběru: míček `frame: 'hero'`, jamka `'target'`.
- Scéna sama volá `session.advance` (jako ostatní scény žánrů) – kostra to nedělala, hodiny by stály.

### Kamera (`minigolfCameraPose(state, aspect, rect, course, fov)`)

- Klid: 2,6 m za míčkem po ose míření ze stavu, 1,1 m nad zemí, pohled 2,2 m před míček. Míček v pohybu: 3,6 m za,
  2,2 m nad, pohled 1,2 m před; osa zůstává z `aux0` (ne ze směru valení). Přechod tlumí scéna (5/s).
- Na výšku `fitTall` (`usePlayRectRef`) s krabicí míček + cíl ± 0,6 m (cíl do 1,6 m = vlajka). Cíl
  (`minigolfFocus`) = nejvzdálenější bod trasy, ke kterému vede přímka celá po dlaždicích (vzorky po 0,25 m): na rovné
  dráze jamka, z odpaliště L / S roh, z rohu další bod. Na šířku vlastní póza, `rect` ji nemění (test).
- Statická část jamky (`minigolfCourseView(world.initial, layout)`) je čtvrtý parametr; plán psal `(state, aspect,
  rect)`, jamka ve stavu není (rozložení je v parametrech ovládání).

### Natažení a klávesnice

- **Prst** kdekoli ve vrstvě (`data-testid="minigolf-pull"`, celá stage, nad plátnem, pod HUD): rána jde proti tahu
  vůči ose míření ze stavu při stisku (tah dolů = vpřed, dolů-vlevo = vpřed-vpravo, nahoru = zpět ke kameře). Mrtvá
  zóna 24 px (puštění v ní = zrušení, nabití `DOWN`), za ní 3 px na tik nabití, plná síla (60) od 204 px.
- **Tik** (`puttInput`): `HOLD` s osou, dokud nabití ve stavu nedožene délku tahu, pak osa bez tlačítek, po puštění
  `TAP` s osou. Puštění dřív, než nabití dožene, ránu odloží (≤ 60 tiků) – síla = délka tahu. Zkrácení tahu o víc než
  4 nabití nabití shodí (`DOWN`) a nabije znovu (přetečení ≤ 4 snese několik tiků v jednom snímku).
- **Klávesnice** (desktop): ←/→ (A/D) otáčí osu o 5 za tik (54°/s) a o 5 hned při stisku, mezerník držený nabíjí,
  puštěný odpálí. Mezerník má `preventDefault` i při opakování – jinak by ho HUD vzal jako pauzu (`useHudKeys`).
  Prst a klávesnice jsou tatáž funkce: tah s nabitím N a osou A dá přesně týž záznam (N× `HOLD`+A, pak `TAP`+A) jako
  mezerník držený N tiků s osou A (test, i hash stavu).
- **Bez dvojího odpálení:** `ArcadeStage` pro vstup `throw-rig` na plátně nic nemontuje (jen VR přes `xr/input-map.ts`)
  a minigolf nemá blaster, akce ani schopnosti – klávesy a dotyk má jen tato vrstva. Žádné akční tlačítko.
- **Montáž:** `GENRE_TOUCH` montuje jen vstup `genre`, takže scéna připojí `MinigolfTouch` do `surface` vlastním
  kořenem Reactu (`createRoot`; drei `Html` by vrstvu schoval, když je počátek světa za kamerou). Props jsou
  `GenreTouchProps` (`{ session }`) – P68-I ho může montovat registrem beze změny komponenty.
- Rána za pohybu míčku je pravidlo jádra (puštění nic nedá, nabití pryč); vrstva ho nehlídá.

### HUD – co ukazuje dnes a popisky

- **Dnes HUD minigolfu nemá žádné počítadlo:** `hudCountersOf` (`ArcadePlay.tsx`) skládá popisky jen z
  `spec.control` a pravidel (`shots` pro `shooter`/`throw`/`ball`, `ammo` u blasteru, `lives`, cíl Dare, `collected`).
  Minigolf nedostane nic → pilulka postupu chybí, vidět je jen časovač (počítá nahoru) a pauza; čtečka dostane
  „0 % · skóre points“ a „{z míčku} m“ (`progressLabel`). `snapshot.shots` = `ammo` + `reserve` = rány + par.
- **Bez sdílené úpravy hra popisky nedá** – žádný háček žánru do `hudCountersOf` není. Náhrada do zapojení:
  `MinigolfTouch` kreslí vlastní pilulku vlevo dole nad dolní řadou (`--_stack`): `hud-counter-strokes`
  (`data-count` = rány, text „1 stroke“ / „2 strokes“) a `hud-counter-par` („par 3“). **Až P68-I přidá
  `strokes` / `par` do `hudCountersOf`, pilulku ze `MinigolfTouch` smazat** (jinak dvě stejná `data-testid`).

### Pro T9 (e2e)

- Selektory: `[data-testid="minigolf-pull"]` (plocha tahu, `data-pulling="true"` během gesta),
  `[data-testid="minigolf-power"]` (`role="meter"`, `aria-valuenow` = nabití ze stavu, vidět jen během gesta),
  `[data-testid="hud-counter-strokes"]` / `hud-counter-par` (`data-count`), `[data-testid="minigolf-score"]`.
- Začátek tahu na výšku: kdekoli pod horním pásem HUD (spodní hrana `.play-hud-progress, .play-hud-corner,
  .play-hud-goal`) a nad dolní řadou – např. 50 % šířky, 40 % výšky stage; plný tah dolů (≤ 204 px) se tam vejde.
  Pohyby prstu jdou do vrstvy i nad HUD (zachycení ukazatele).
- Tah pro přání robota: `pullFor(base, axis, charge)` z `minigolf-touch.ts` (`base` = `aux0` míčku ve stavu při
  stisku) – přesný opak `pullBack`, souřadnice smí být necelé. Puštění kdykoli po tahu (rána počká na nabití).
- Klávesnice: `ArrowLeft` / `ArrowRight` (5 os za tik), `Space` držet a pustit.

### Sdílené potřeby (P68-I, nic se neměnilo)

1. `hudCountersOf` / `progressLabel` v `ArcadePlay.tsx`: počítadla `strokes` (`MINIGOLF_COUNTER.strokes` = `ammo`)
   a `par` (`reserve`) pro ovládání `minigolf`; pak smazat náhradní pilulku (viz výš).
2. Čistá montáž `MinigolfTouch`: registr dotyku i pro `throw-rig` (nebo vstup `genre` pro minigolf); pak smazat
   `useTouchLayer` ve scéně.

### Ověřeno

`npx vitest run src/components/play/arcade/genres/minigolf` 13/13; spolu s jádry `stunt`/`minigolf`, `p68-hash`,
`p68-staged` a hlídači pruhu 120/120. Rozbito schválně (pin, nepovinné): znaménko `dx` v `pullBack` → 2 testy
červené; póza na výšku bez `fitTall` → test rámování červený. `npm run build` prošel. Na živém prohlížeči neověřeno
(e2e je T9).

## Milníky a žebřík zjednodušení

| hra | milník | stupeň zjednodušení | splněno |
|---|---|---|---|
| `stunt` | 2. 11. 2026 (T5) | 0 (plný rozsah) | ano – 1. 11. 2026, `6272a38a`; FPS `chromium` medián 59,9 / p95 16,8 ms (brána ≥ 40 / ≤ 33,3 prošla), `pixel7-touch` 59,9 / 16,8, `iphone-touch` 15,2 / 101 ms (bez brány) |
| `minigolf` | 3. 11. 2026 (T9) | 1 – celočíselné kutálení místo koule Rapieru (spike T6: Rapier zastavil 21/50 ran do 180 tiků, kutálení 50/50) | ano – 1. 11. 2026 (sha commitu T9 v `git log`, `test(play): minigolf end to end…`); FPS `chromium` medián 59,9 / p95 16,7 ms (brána prošla), `pixel7-touch` 59,9 / 16,7, `iphone-touch` 62,5 / 72 ms (bez brány) |

**T5 (`stunt` e2e, 1. 11. 2026):** `e2e/play-stunt.spec.ts` z ručního specu `e2e/fixtures/p68-stunt-spec.json` (seed 1),
12/12 na `chromium`, `pixel7-touch`, `iphone-touch`; `play-drive` a `play-physics-replay` na `chromium` 5/5. Žebřík
nebyl potřeba. Otisk: záznam robota od tiku 0 dá v prohlížeči na všech třech projektech `ec27fd3c` = Node
(`stunt-hash.json`, drží `stunt-replay.test.ts`, který také pinuje tiky snímků). FPS `fps-stunt.json` (10 s ukázky robota).
Výklad: (1) nečinný hráč dostane kartu prohry „Try again!“, ne „So close.“ – sdílený `runResult` dává „So close.“ jen
prohře s body (P56A T9); (2) prst na Chromiu: CDP `touchMove` bez zvednutého prstu brzdu nepustil (brzda zůstala držet
do konce), test proto zvedá všechny prsty a zbylé pokládá znovu na místo stisku – vada emulace, ne hry; (3) iPhone =
WebKit na Windows: plátno WebGL na snímcích prázdné (i u jiných her, `D:/caches/p64/audit/iphone15`), FPS jen zapsané.
Oko (`D:/caches/p68/v/stunt/`): auto čitelné, rampy, hromady, letící bedny a úlomky, brána cíle i palec vidět; na šířku
telefonu (839 × 412) sedí auto těsně nad dolní lištou HUD a stín skoku pod ní zmizí; štítek ducha „Best run“ leží na
autě, když se jede přesně stopou robota.

**T9 (`minigolf` e2e, 1. 11. 2026, před milníkem – stupeň zjednodušení zůstává 1):** `e2e/play-minigolf.spec.ts` z ručního
specu `e2e/fixtures/p68-minigolf-spec.json` (= `SAMPLE` z `minigolf-module.test.ts`: jamka do L, tři dýně, pohyblivá
rakev; seed 1), 12/12 na `chromium`, `pixel7-touch`, `iphone-touch`; `play-ball` na `chromium` 4/4.
- *Telefon:* prst hraje podle `botWants` – stisk na 50 % šířky a 40 % výšky scény (pod horním pásem HUD, na vrstvě
  `minigolf-pull`), natažení `pullFor(míření při stisku, osa, k)` roste o jedno nabití za každý tik, kdy robot drží
  `HOLD`, puštění = `TAP`. Robot dá jamku na 2 rány (par 3), `Strokes` v DOM 2, měřič síly vidět, karta „You did it!“.
- *Desktop:* `→` otočí míření, držený mezerník nabije (měřič > 0), puštěný odpálí: `HOLD` i `TAP` s osou > 0 v záznamu,
  `Strokes` = 1; zbytek `handPlay` → výhra, `TAP` v záznamu = rány robota v Node (2).
- *Nečinný:* `idleRun` → prohra, 0 `TAP`, karta prohry bez „You did it!“.
- *Otisk:* záznam robota od tiku 0 dá v prohlížeči na všech třech projektech `43e13345` = Node (`minigolf-hash.json`;
  `minigolf-replay.test.ts` pinuje otisk, rány robota – tik 17→65 osa 0 nabití 48, tik 169→214 osa 488 nabití 45 – a
  míření 0 na tiku 0, ze kterého prst počítá tah).
- *FPS* (`fps-minigolf.json`): jamka robota trvá 280 tiků (4,7 s), okno 10 s proto obsahuje celou ukázku (test hlídá,
  že doběhla uvnitř okna) a ~5 s scény po výhře. Brána platí jen pro `chromium`.
- *Míček a jamka na výšku:* u poslední rány (nabití 30, kamera usazená 1,2 s) oba celé v záběru (`__playFrame`
  `hero` / `target`) na obou telefonech. Na šířku se to jen zapisuje (na všech projektech ano).

Výklad: (1) **štítek ducha „Best run“ chytá dotyk.** Duch přehrává ověřený běh robota; když hráč hraje přesně jako robot,
štítek leží nad míčkem – tam, kde hráč začíná tah („Drag back from the ball“). Na `iphone-touch` trefil stisk druhé rány
`play-ghost-tag` místo vrstvy natažení: sdílený `Ghost.tsx` dává drei `Html` `pointerEvents="none"`, ale drei ho mimo
režim `transform` nepoužije. Test proto začne tah o 10 % výšky níž a zakrytí zapíše (`blocked` v anotaci); oprava
patří do `Ghost.tsx` (`integration.md`). (2) První `POST` po startu serveru u minigolfu 422 nevrací (na rozdíl od
`stunt`) – minigolf Rapier nepotřebuje.
Oko (`D:/caches/p68/v/minigolf/`, Pixel a Chromium; WebKit kreslí prázdné plátno jako u stunt): míček, trávník,
mantinely, dýně na soklech, jamka s vlajkou, tečky míření, pilulka „1 stroke · par 3“ a měřič síly vidět. Slabiny:
míček je zvětšený čitelností (~⅕ šířky na výšku); na šířku je jamka malá a napůl za štítkem ducha; na snímku
`portrait-hole` u míčku tmavě zelený nakloněný kotouč na stopce, jehož původ (model rakve, nebo duch) snímek neurčí.

## Hlídače

- **Vlastnictví** – `owned-paths.mjs`: `git diff --name-only origin/main...HEAD | node evals/play/p68/vozidla-sport/owned-paths.mjs`
  vrátí 0 jen když diff obsahuje výhradně soubory pruhu (moduly `src/play/genre/{stunt,minigolf}.ts`, soubory
  `stunt*` / `minigolf*` přímo v `src/play/arcade/pieces/` a jejich testy, `src/components/play/arcade/genres/{stunt,minigolf}/**`,
  `e2e/play-{stunt,minigolf}.spec.ts`, `e2e/fixtures/p68-{stunt,minigolf}-spec.json`, `evals/play/p68/vozidla-sport/**`).
  Jinak vypíše cizí cesty a vrátí 1. Test: `__tests__/owned-paths.test.ts`.
- **Směrování** – `route-before.json` = `classifyGenre(věta, null).ranked[0]` (žánr a režim rychlé hry, bez modelu)
  na všech 200 větách `evals/play/p30/test-200.json`. `__tests__/routing-guard.test.ts` spočítá totéž na větvi
  a selže při jakékoli změně. Přepočet: `node evals/play/p68/vozidla-sport/route-snapshot.mjs`. Když `origin/main`
  směrování legitimně změní (P68-I zapojí hru), snímek se přepočítá z čistého checkoutu `origin/main`:
  `node evals/play/p68/vozidla-sport/route-snapshot.mjs --root <checkout origin/main>` – nikdy z větve pruhu.
- **Solver** – `__tests__/solver-untouched.test.ts`: `git diff --quiet <merge-base HEAD origin/main> -- src/play/arcade/physics
  src/play/arcade/contract.ts src/play/arcade/kernel.ts` vrátí 0. Srovnává se s místem odbočení, ne s hrotem
  `origin/main`: když P68-I sám změní `contract.ts`, není to změna pruhu a test nemá zčervenat. Kontrolní případ
  (rodič posledního commitu se `step.ts`) dokazuje, že tentýž příkaz změnu vidí.
- **Dev věty** – `dev.json`, 10 na `stunt` a 10 na `minigolf`. `__tests__/dev-sentences.test.ts` hlídá, že žádná
  není v `p30/test-200.json` ani v jiné sadě vět pod `evals/play` (normalizovaný text). Ladí se jen na nich.

## Inventura modelů

`node evals/play/p68/vozidla-sport/model-inventory.mjs` na `688d989d` (= `origin/main` bez kostry; kostra modely nemění).
`nalezeno` = tag katalogu (`modelOf`), `nearest` = jen nejbližší model (`sceneModelOf`), `chybí` = scéna kreslí procedurálně.

| věc | `modelOf` | `sceneModelOf` | stav |
|---|---|---|---|
| car | race-car | race-car | nalezeno |
| sports car | race-car | race-car | nalezeno |
| police car | gen3d-police-car | gen3d-police-car | nalezeno |
| monster truck | gen3d-monster-truck | gen3d-monster-truck | nalezeno |
| truck | cc0-garbage-truck | cc0-garbage-truck | nalezeno |
| bus | cc0-bus | cc0-bus | nalezeno |
| motorbike / motorcycle | gen3d-motorbike | gen3d-motorbike | nalezeno |
| scooter | gen3d-scooter | gen3d-scooter | nalezeno |
| tractor | cc0-tractor | cc0-tractor | nalezeno |
| buggy | gen3d-ride | gen3d-ride | nalezeno |
| ramp | gen3d-ramp | gen3d-ramp | nalezeno |
| crate / box | crate | crate | nalezeno |
| barrel | cc0-barrel | cc0-barrel | nalezeno |
| tire | tire-barrier | tire-barrier | nalezeno |
| cone | cone | cone | nalezeno |
| fence | iron-gate | iron-gate | nalezeno (brána místo plotu) |
| hay bale | cc0-hay-bale | cc0-hay-bale | nalezeno |
| trash can | cc0-trash-can | cc0-trash-can | nalezeno |
| watermelon | gen3d-suika | gen3d-suika | nalezeno |
| bridge | wooden-bridge | wooden-bridge | nalezeno |
| golf ball | gen3d-golf-ball | gen3d-golf-ball | nalezeno |
| ball | ball | ball | nalezeno |
| hole | – | – | **chybí** → procedurální jamka (válec + okraj) ve scéně |
| flag | finish-flag | finish-flag | nalezeno |
| windmill | gen3d-windmill | gen3d-windmill | nalezeno |
| golf club | gen3d-golf | gen3d-golf | nalezeno |
| bumper | tire-barrier | tire-barrier | nalezeno |
| log | cc0-wood-log | cc0-wood-log | nalezeno |
| pumpkin | cc0-pumpkin | cc0-pumpkin | nalezeno |
| coffin | gen3d-coffin | gen3d-coffin | nalezeno |
| rocket | rocket | rocket | nalezeno |
| castle | gen3d-kingdom | gen3d-kingdom | nalezeno |
| penguin | penguin | penguin | nalezeno |

Rampa má model (`gen3d-ramp`); jeho tvar se v T4 ověří proti skokové hraně. Chybějící jamka a případně dráha
minigolfu se kreslí procedurálně; kandidát z CC0 kitu je v `integration.md`.
