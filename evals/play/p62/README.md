# P62 – vzhled scény: audit, zapečetěná sada a výchozí stav `main`

Plán: `plans/P62-vzhled-sceny-2026-10-26.md` (gitignorovaný). Měřidlo je P61 beze změny (`evals/play/p61/shots.mjs`, `judge.mjs`, popis v `evals/play/p61/README.md`).

Měřený `main` = `495bbc77` (P61 po sloučení, PR #54): build ve worktree `demo-main-2026-10-23`, audit nad `src/` téhož commitu (`audit.json` → `srcCommit`).

## Audit scény (T1)

`audit.mjs` → `audit.json` (řádek na hru) a `missing-nouns.json`. Spuštění: `node evals/play/p62/audit.mjs` (sám se znovu spustí s `--experimental-strip-types`, `Scenery.tsx` přeloží `transformWithOxc` z vite).

**Co se měří.** 220 různých vět ze sad `p30/dev.json` (60), `p58b/holdout.json` (80, otevřená v P58B) a všech sad vět `p56c/*.json` (90). Zapečetěné sady se nečtou. Rychlá hra vzniká jako na dveřích `/api/play/games` s čtečkou jen pro AI verzi (recept P61): 108 vět dá řetěz mikroher (audituje se kolo 1), 112 návrh ze slov. Nic se nehraje ani nefotí – všechno je ze specifikace a z kódu rozmístění.

- **Nepřítel, předmět, překážka:** model, který scéna pro roli vybere (`enemyModel`, `chaserModel`, `heroChoice`, `propModels` / `namedProps` → `sceneModelOf`).
  - `own` = jména modelu (identita manifestu, štítky katalogu včetně jména ze slepého soudu, holé id) nesou hlavní podstatné jméno popisku.
  - `modifier` = model nese jen jiné slovo popisku („robot eels“ → robot).
  - `substitute` = příbuzná postava (`kin`), zástupce kategorie, nejbližší model (`nearest`), náhrada ze slovníku (`near-word`) nebo výchozí robot. **Náhrada se nikdy nepočítá jako vlastní model** (`__tests__/audit.test.ts`).
  - `none` = scéna kreslí vlastní tvar jádra (minci, kvádr).
  - Popisek, který věta vůbec neříká (výchozí „turbo“, „rival car“, nepřítel podle světa), se nepočítá – je ve `genreDefault`.
- **Ručně zapsaná jména sady:** P30 kontrolní seznam podle `does`, P58B pole `foe` a `item`. Hledají se v knihovně stejně, jak by je kreslila scéna, i když je rychlá hra do role nedala.
- **Interiér:** sady `mall`, `supermarket`, `living_room`, `factory`, `castle`, `cave` (výčet plánu). Podlaha „uvnitř“ = dlažba nebo skála arény, dlážděná nebo prkenná cesta; stěny = prstenec stěn arény.
- **Kulisy uvnitř a na okraji:** řady `Scenery` přes skutečné `sceneryPlaces` s argumenty každé scény (tabulka `SCENES` v `audit.mjs` s cestami k řádkům). Orientační bod, rámující kusy a prstenec arény stojí z konstrukce mimo hrací plochu (`landmark-places.ts`, `arenaDecor.ts`). Hrací plocha střelnice je kužel míření ±45° do dostřelu 36 m (`pieces/shooter.ts:463-464`). Závod (`steer`, 10 her) audit nemodeluje.

### Výsledek na `main`

| Co | Počet | Vlastní model | Modifikátor | Náhrada | Bez modelu |
|---|---|---|---|---|---|
| nepřítel z věty v rychlé hře | 27 | 24 | 1 | 2 | 0 |
| nepřítel zapsaný sadou | 75 | 66 | 4 | 5 | 0 |
| sbíraný předmět z věty | 53 | 46 | 1 | 2 | 4 |
| předmět zapsaný sadou | 37 | 29 | 0 | 2 | 6 |
| překážka z věty | 29 | 23 | 1 | 0 | 5 |

- Výchozí popisky žánru mimo počty: nepřítel 26, předmět 73, překážka 86.
- Náhrady nepřítele v rychlé hře jsou obě ze špatně přečtené věty („mixed“ → robot, „counter“ → barový pult). Ze zápisu sad: úhoři → robot, krtci → křeček, krápníky → krápník ze země, lisy a kaktusy → robot.
- **Interiéry: 56 her, 35 bez podlahy, 41 bez stěn.**
  - Podlahu i stěny má jen aréna (15 her).
  - Podlahu bez stěn mají běžec a závod (6 her, dlážděná cesta).
  - Bez podlahy: pruhy (10), střelnice (6), plošinovka (4), načasování (3), poletování (3), let (2) a po jedné další žánry.
- **Prázdná hrací plocha: 191 z 210 her.** Kulisa uvnitř je jen ve dvou žánrech:
  - střelnice: 37 kusů ve 13 hrách – řada 14–19 m do strany leží v kuželi míření, ale daleko od terčů;
  - rytmus: 6 kusů v 6 hrách – první kus levé řady stojí v pruzích na x = −2,7 m, protože `sceneryPlaces` počítá posun `% 5` ze záporného čísla.
  - Na okraji stojí 6126 kusů (řady, orientační body, rámující kusy, prstenec arény).
  - Aréna má navíc 30–480 drobností podlahy do 0,45 m na hru; kulisa to není.

**Odvození pro další úlohy** (z čísel výš, neměřeno):
- T3: aréna dlažbu a stěny už má. Prázdné interiéry jsou hlavně v pruzích, střelnici a plošinovce – T3 v aréně změní nejvýš 15 z 56 interiérů.
- T4: aréna (36 her) a střelnice (13) jsou 49 z 220 her. Uvnitř arény dnes nestojí nic vyššího než 0,45 m.
- T2: vlastní model chybí málo nepřátelům. Z šesti hotových modelů T2 se v sadách auditu objevuje jen `stalactite`; `cheetah`, `snowplow`, `firecracker`, `pinecone` a `termite` v nich nejsou.

### Chybějící jména (`missing-nouns.json`)

Hlavní podstatné jméno role bez vlastního modelu, bez slov z `ops/gen3d/not-nouns.txt`. Řazení: nepřítel > sbíraný předmět > kulisa, pak počet vět (všechna kromě úhoře jsou v jedné větě).

- **Nepřítel (10):** eel (2 věty), box, branch, cacti, counter, mixed\*, mole, press, shutter, stalactite.
- **Předmět (11):** card, date, firewood, grocery, hatchery, honey, mango, pebble, plan\*, reed, shoebox.
- **Kulisa (7):** budget\*, crack, frisbee, charger, physics\*, pit, tax\*.

\* Špatně přečtená věta nebo abstraktní slovo – do výroby nepatří. `not-nouns.txt` je nevylučuje a seznam zůstává, jak vyšel.

## Zapečetěná sada

`holdout.json` – 24 nových anglických vět, napsaných 27. 10. 2026 před první změnou scény P62, jen z podstatných jmen (žádná cizí hra):
- **8 interiérů:** obchodní centrum, supermarket, obývák, továrna, hrad, jeskyně, kavárna, nemocnice;
- **8 venkovních míst:** farma, pláž, horský průsmyk, les, střechy města, kráter, poušť, oceán;
- **8 vět s nepřítelem bez vlastního modelu** z `missing-nouns.json`: eel, mole, stalactite, cacti, branch, press, box, shutter. Jednou ověřeno vyhledáním v knihovně (`heroChoice`), ne hraním.

Žádná věta se neshoduje, ani skoro (podíl společných slov ≥ 0,3), s `p30/*.json`, `p56c/*.json`, `p58b/holdout.json`, `p61/holdout.json` ani další známou sadou (`__tests__/seal.test.ts`). Nejbližší dvojice je 0,22. Věty, které se s dřívějšími sadami potkaly obsahem (krtci „popping up … bonk“, potápěč a úhoř ve vraku), se přepsaly ještě před zapečetěním.

SHA-256 nad LF bajty: `7863a64004efbc746fbec880a06f5ec04c16d114e32153c60541e4c413ca99a9` (`seal.ts`). Otevře se jednou v T7; nic se podle ní neladí. Otevřená v T7 27. 10. 2026 ve 21:30 UTC na větvi `569aba6f` (`holdout-opened.json`), otisk při otevření seděl.

Snímky `main`: 24/24 rychlých her (desktop i Pixel 7, po třech snímcích) a 7 her ze čtení, 186 souborů v `D:/caches/p62/main-holdout/`, nesouzené.

## Výchozí stav `main` na dev (T1, 27. 10.)

Dev věty `p30/dev.json` [0..11], desktop, soudce Claude Opus 5.5 (`claude -p --safe-mode`), seed 61026, dva běhy na týchž listech → `baseline-dev.json`. Snímky `D:/caches/p62/main-dev/`, listy `D:/caches/p62/sheets-dev/`.

| Strana | Věrnost | Hrál bych | Vět |
|---|---|---|---|
| rychlá hra | 0,525 (2. běh 0,525) | 0,375 (0,40) | 12 |
| hra ze čtení (jen kde vznikla) | 0,40 (0,45) | 0,45 (0,45) | 2 |
| po čtení (hra ze čtení, jinak rychlá) | 0,525 (0,525) | 0,375 (0,40) | 12 |

- Rozptyl soudce mezi běhy (14 dvojic věta × strana): medián rozdílu 0,025 / 0, největší 0,10 / 0,15.
- Hra ze čtení vznikla jen u dvou řetězů (s006, s022). U ostatních vět čtení proběhlo a zaplatilo se, hra ze čtení nevznikla.
- Proti T1 v P61 (`main` 5692b987: rychlá 0,375 / 0,325) je rychlá hra po sloučení P61 o 0,15 věrnější a o 0,05 lákavější.

Největší výtky soudce u rychlé hry (1. běh, věrnost / hrál bych):
- **Prázdná scéna, malí nepřátelé:**
  - s039 zombie v obchoďáku 0,60 / 0,40 – „small zombie figures … mall only hinted at by ceiling lights and a few shop props in a hazy empty space“;
  - s037 brouci 0,60 / 0,40 – „bugs are barely visible and the scene feels empty and murky“;
  - s002 hrad 0,60 / 0,35 – „scene looks sparse and placeholder-like“.
- **Interiér jako venek:** s003 supermarket 0,40 / 0,40 – „outdoor road through a snowy landscape, not a supermarket interior“.
- **Chybí, co věta jmenuje:** s022 věž 0,35 / 0,30 – „no tower to climb“; s069 match-3 v jeskyni 0,15 / 0,15 – „just a few crates and a crystal gem on a dim surface“.

## Opravy (T2–T4, 27. 10.)

**Knihovna (T2).**
- Povýšeno 6 modelů (cheetah, snowplow, firecracker, pinecone, termite, stalactite), všechny prošly kontrolou kvality `ops/gen3d/quality_gate.py` (LOD0 ≤ 4742 trojúhelníků, bez fialové) i slepým soudem čtyř pohledů (6/6). Leží v `gen3d-p37d/` vedle dřívějších povýšených modelů.
- Aliasy 2: sentry a marine kreslí existujícího vojáka `gen3d-guard` (dřív robot a astronaut).
- Odmítnuto 4 už při výrobě: gopher a bulldog (rozsekané střepy), mango (vypadá jako citron), mole (rozbitá síť).
- Proti `missing-nouns.json`: z 28 chybějících jmen pokrývá T2 jen `stalactite`. Nepokrytí nepřátelé: eel, box, branch, cacti, mole, press, shutter (counter a mixed jsou špatně přečtené věty); předměty a kulisy viz seznam výš. Nový model jen v T6.

**Interiéry (T3).** Šest interiérů má v arénových žánrech vlastní podlahu (obchoďák krémová dlažba, supermarket šachovnice, obývák prkna, továrna kovové pláty, hrad kamenné desky, jeskyně břidlice) a prstenec stěn z kulis své sady místo blokových stěn a pásu rostlin. Přední řada u kamery jen do 1,2 m, aby hrdina zůstal vidět. `space` beze změny – arénu má skalnatou s balvany, ne prázdnou plochu. Podle auditu T3 zasáhne nejvýš 15 z 56 interiérových her; zbytek (pruhy, střelnice, plošinovka) zůstává pro T6.

**Hrací plocha (T4).** Aréna (útěk, sběr, souboj, úkol) a střelnice má 4–10 kulis ze sady místa (stojany, figuríny, trůny…), rozmístěných ze semínka hry mimo cestu robota, spawny a dráhy nepřátel i ran. Jsou to jen dekorace, hash hry je stejný jako na `main`. Cestu robota počítá worker v prohlížeči, takže se kulisy objeví až kolem 3 s po načtení scény (při CPU 4× 10–14 s).

Kreslicí volání scény (Pixel 7, hra stojí na tiku 60, medián 9 vzorků, kulisy skryté → ukázané přes `window.__playField`):

| Scéna | Pixel 7 | Desktop |
|---|---|---|
| aréna hrad | 38 → 46 | 60 → 72 |
| aréna obchoďák | 23 → 25 | 48 → 56 |
| střelnice obchoďák | 43 → 49 | 86 → 95 |

**Kulisy hned (T4-R1).** Stránka si kulisy u workeru vyžádá už při hydrataci, první úloha jde ve jménu workeru. Medián 15 načtení: na Pixel 7 s CPU 4× stojí kusy ve scéně 2,3 s před prvním snímkem (dřív 8,2 s po něm), na desktopu 1,4 s po něm (dřív 5,3 s; cíl 1 s nesplněn – scéna se připojí 0,3 s po hydrataci, dřív než worker doběhne). V 1 s není v headless Chromiu načtený žádný model scény, ani hrdina; modely kulis přicházejí spolu s ostatními. Levnější zakázaná zóna bez robota nejde: cesta robota v útěku a sběru pokryje 47–78 % arény.

**Typ rytmu (T1-R1).** První levý kus řady kulis rytmu stál v pruzích (záporný zbytek v `sceneryPlaces`); teď stojí za `inner` jako ostatní.

**Čitelný nepřítel (T5).** Nepřítel z věty ve střílečce a aréně se zvětšuje podle toho, kolik zabírá na obrazovce (nejvýš 2×, cíl 10 % výšky nebo šířky záběru). Terč na střelnici kreslí stejnou postavu jako vlny nepřátel a kamera střelnice je blíž (na šířku 48° místo 60°, na výšku níž a blíž). Kolize, robot ani přehrání se nemění.

| Hra | Desktop | Pixel 7 |
|---|---|---|
| střelnice zombie | 4,7 → 11,4 % | 4,5 → 11,3 % |
| střelnice brouci | 2,5 → 12,7 % | 5,0 → 10,7 % |
| aréna sběr | 6,5 → 10,4 % | 6,3 → 10,6 % |
| aréna útěk | 24,8 → 24,0 % | 23,5 → 19,6 % |
| aréna souboj | 16,6 → 16,6 % | 22,0 → 22,0 % |
| úkol | 14,8 → 17,0 % | – → 11,4 % |

**Kamera arény na výšku (T5-R1).** Kamera na telefonu drží nepřítele v záběru celým tělem (po zvětšení z T5) a sleduje i přepadníka ve sběru; když se celé tělo nevejde, zůstane starý záběr. Desktop beze změny.

| Hra | Pixel 7: v záběru, useknutý | iPhone: v záběru, useknutý |
|---|---|---|
| útěk | 20/29, 65 % → 23/29, 0 % | 26/29, 88 % → 27/29, 0 % |
| sběr | 1/30, 100 % → 24/30, 4 % | – → 29/30, 3 % |

- **Nesplněno:** nepřítel ve sběru má na telefonu 9,1–9,7 % výšky záběru místo 10 % – udržet v záběru nepřítele 15–33 m daleko chce kameru 14–18 m vzadu a zvětšení končí na 2×. Přednost dostal záběr; práh v `e2e/p58a-framing.spec.ts` je pro sběr na telefonu 8,5 % s důvodem u něj.
- Úkol je z nových kontrol na telefonu vyjmutý: stráže stojí 6–10 m do strany, v záběru byly 18/30 už před změnou, teď 16–18/30.

## Větev na dev po T2–T5 (T6, 27. 10.)

Větev = `6beb49d3` (T2–T5 a opravy T1-R1, T4-R1, T5-R1), tytéž dev věty `p30/dev.json` [0..11], desktop, soudce Claude Opus 5.5 (`claude -p --safe-mode`), seed 61026, dva běhy na týchž listech → `after-dev.json`. Snímky `D:/caches/p62/p62-dev/`, listy `D:/caches/p62/sheets-p62-dev/`. List nese jen řádky větve, jako list T1 jen řádky `main` – srovnává se číslo s číslem, na jednom listu soudí až T7. Žánr a sada vyšly u všech 12 vět stejně jako na `main`; hra ze čtení vznikla zase jen u řetězů s006 a s022.

| Strana | Věrnost | Hrál bych | Vět |
|---|---|---|---|
| rychlá hra | 0,50 (2. běh 0,50; `main` 0,525 / 0,525) | 0,40 (0,425; `main` 0,375 / 0,40) | 12 |
| hra ze čtení (jen kde vznikla) | 0,40 (0,375; `main` 0,40 / 0,45) | 0,40 (0,425; `main` 0,45 / 0,45) | 2 |
| po čtení (hra ze čtení, jinak rychlá) | 0,50 (0,50; `main` 0,525 / 0,525) | 0,425 (0,425; `main` 0,375 / 0,40) | 12 |

- Rozptyl soudce mezi běhy větve (14 dvojic věta × strana): medián rozdílu 0,05 / 0,05, největší 0,05 / 0,05.
- Průměr rychlé hry (doplněk k mediánu, oba běhy): věrnost 0,475 / 0,479 → 0,513 / 0,508, hrál bych 0,375 / 0,385 → 0,396 / 0,400.

Po větách, věrnost / hrál bych, `main` → větev, 1. běh (2. běh v závorce):

| Věta | Rychlá hra | Po čtení | Hlavní výtka soudce u větve |
|---|---|---|---|
| s039 zombie shooter in a mall | 0,60 / 0,40 (0,60 / 0,40) → 0,75 / 0,55 (0,75 / 0,50) | = rychlá | „reads as a mall, but the setting is a washed-out, sparse open space and the zombies are small“ |
| s037 space marine, alien bugs | 0,60 / 0,40 (0,60 / 0,40) → 0,70 / 0,50 (0,70 / 0,45) | = rychlá | brouci malí, scéna kalná a statická |
| s002 knight, three keys | 0,60 / 0,35 (0,55 / 0,35) → 0,75 / 0,50 (0,75 / 0,50) | = rychlá | sedí s větou; tmavé a řídké, postavy malé |
| s003 hamster, supermarket | 0,40 / 0,40 (0,45 / 0,40) → 0,45 / 0,40 (0,40 / 0,40) | = rychlá | „looks like an outdoor road over pale hills rather than a supermarket“, Roomba není vidět |
| s006 corgi, park | 0,30 / 0,40 (0,25 / 0,35) → 0,30 / 0,30 (0,25 / 0,30) | 0,45 / 0,55 (0,45 / 0,50) → 0,40 / 0,45 (0,35 / 0,50) | corgi, párky ani postřikovače nejsou poznat; 2 ze 3 snímků tmavé a šedé |
| s008 banana, temple run | 0,60 / 0,55 (0,55 / 0,55) → 0,55 / 0,50 (0,60 / 0,55) | = rychlá | opice není vidět, jen červený kvádr a oranžová skvrna |
| s022 tiny robot, tower | 0,35 / 0,30 (0,45 / 0,45) → 0,45 / 0,40 (0,45 / 0,45) | 0,35 / 0,35 (0,45 / 0,40) → 0,40 / 0,35 (0,40 / 0,35) | žádná věž, plošiny se nehýbou; ve hře ze čtení modrý náhradní kvádr |
| s021 obby, lava | 0,55 / 0,50 (0,55 / 0,50) → 0,55 / 0,50 (0,50 / 0,45) | = rychlá | rotující tyče nejsou |
| s035 flappy underwater | 0,60 / 0,35 (0,60 / 0,35) → 0,60 / 0,30 (0,60 / 0,35) | = rychlá | 2 ze 3 snímků konec hry po 0,9 s |
| s050 snowballs at kids | 0,45 / 0,35 (0,50 / 0,40) → 0,40 / 0,35 (0,45 / 0,40) | = rychlá | děti malé, tučňák a iglú místo pevnosti |
| s088 angry birds, cats | 0,50 / 0,35 (0,50 / 0,35) → 0,45 / 0,30 (0,50 / 0,30) | = rychlá | krabice malé a daleko, prak chybí |
| s069 candy crush, cave | 0,15 / 0,15 (0,15 / 0,12) → 0,20 / 0,15 (0,15 / 0,15) | = rychlá | match-3 chybí |

- Tři věty, na které opravy P62 míří (střelnice s039 a s037, hrad v aréně s002), stouply v obou bězích o 0,10–0,20 věrnosti a 0,05–0,15 „hrál bych“ – víc, než soudce kolísá. Výtka „prázdná scéna, malí nepřátelé“ z T1 u nich zůstala jen jako vedlejší.
- Ostatních 9 vět se pohnulo nejvýš o 0,05 (rozptyl soudce). Medián věrnosti klesl o 0,025, protože leží mezi 6. a 7. větou: s050, s088 a s008 o 0,05 níž ho posunuly, zlepšené věty byly nad ním už předtím (odvozeno z pořadí hodnot).

Ztráty podle důvodů soudce u větve (14 řádků 1. běhu, 2. běh totéž), seskupené podle příčiny:
1. **Hala jako venek** – s003 hlavní výtka v obou bězích (věrnost 0,40–0,45, nejnižší ze scénických vět), s039 vedlejší („washed-out, sparse open space“, ve 2. běhu „hazy, empty, beige setting“). Dlažbu interiéru klade jen aréna (T3); údolí běžce a zem ostatních žánrů malují zem sady – u supermarketu světlé skvrny jako sníh a štěrk krajnice podél šedého pásu cesty, u obchoďáku béžovou plochu. Podle auditu T1 je bez vnitřní podlahy 35 z 56 interiérových her a T3 změnil jen arénu.
2. **Postava nebo věc malá či nečitelná** – s039, s037, s002, s050, s088, s008, s003, s006: 8 řádků, u všech kromě s006 vedlejší výtka a každý žánr z jiné příčiny (cíle hodu, pronásledovatel běžce za hrdinou, model hrdiny běžce). Nepřátele střelnice a arény už zvětšil T5.
3. **Kalná nebo tmavá scéna** – s037, s002, s006: 3 řádky.
4. **Chybí mechanika věty** – s069 match-3, s022 věž a pohyblivé plošiny, s021 rotující tyče, s035 konec po 0,9 s, s088 prak: 5 řádků, mimo scénu.
5. **Náhradní kvádr ve hře ze čtení** – s022: 1 řádek.

Jedno kolo opravy dostala ztráta 1: jediná hlavní výtka s jednou příčinou ve scéně, kterou jde opravit na jednom místě (zem interiéru) pro všechny žánry naráz. Ztráta 2 má víc řádků, ale jako vedlejší výtku a s jinou příčinou v každém žánru; 4 je mimo scénu.

### Oprava: podlaha interiéru i mimo arénu

- Dlažba interiéru (`Look.interior.floor`, T3) se klade i v údolí běžce (`buildValley`) a v zemi ostatních žánrů (`buildFieldGround` → `FieldGround`: střelnice, hod, plošinovka, načasování, rytmus, souboj a další). Tytéž dílce jako v aréně (`INTERIOR_LAYOUTS`), tentokrát jako textura 256 × 256 px s jednou periodou kladení (`look/interior-floor.ts`); síť nese UV v metrech a bílé vrcholy, takže barvu dá jen dlažba – žádné světlé skvrny jako sníh ani štěrk krajnice.
- Proč textura a ne síť jako v aréně: trať běžce má stovky metrů a dílce po 1,25 m by byly desítky tisíc trojúhelníků navíc; textura je bez dalšího kreslicího volání.
- Běžec v interiéru běží po rovné podlaze (jako hala z P61) a ulička je ta podlaha: šedý pás cesty se nekreslí, okraje uličky zůstaly jako pruh v barvě spáry.
- Aréna se nemění (svou podlahu klade sítí). Venkovní sady beze změny – otisk údolí, pásů cesty a země je v testu připíchnutý z `6beb49d3`.
- Test `src/components/play/arcade/look/__tests__/indoor-ground.test.ts` (20 případů): z dev vět s003 a s039 přes návrh a `sceneLook` až k tomu, co kreslí `RunnerValley` a `WorldBackdrop` → `FieldGround` – textura je dlažba povrchu (dílce, spáry, u šachovnice druhá barva, žádná fialová), UV = metry, vrcholy bílé, údolí rovné, pás cesty chybí a okraj má barvu spáry; totéž pro všech šest interiérů; 12 venkovních sad proti otiskům. Před opravou 20/20 červených (interiéry „floor texture: expected null“, venkovní jen chybějící otisky, které se pak zapsaly z nezměněného kódu), po ní 20/20 zelených. Rozbité schválně: údolí interiéru se zemí sady místo bílých vrcholů – 7 červených; pás cesty kreslený i v interiéru – první verze testu ho pustila (pás měl barvu dlažby, ne cesty), test teď chce jen okraje uličky a mutant je červený.

Které dev věty se mění (sada a scéna z auditu T1): s003 (běžec, supermarket), s039 (střelnice, obchoďák), s037 (střelnice v „mining colony“ = továrna) a s022 (plošinovka na hradě, břeh za ostrůvky). s002 a s069 jsou aréna, ta se nemění.

Snímky po opravě (čerstvý build, týž server a nastavení) `D:/caches/p62/t6-after/`, prohlédnuté proti `D:/caches/p62/p62-dev/`:
- **s003:** před – světle šedá plocha z trojúhelníků jako zasněžená pláň a šedá silnice s tmavou krajnicí; po – šachovnicová podlaha supermarketu až k regálům a stánkům, ulička vyznačená dvěma šedými pruhy, strop se světly; na telefonu totéž.
- **s039:** před – béžová hladká plocha; po – velké krémové dlaždice se spárami až k fontáně a stojanům s oblečením.
- **s037:** před – tmavě hnědá pláň; po – šedé kovové pláty se spárami. Těžba je teď průmyslová plošina; scéna je světlejší, ne kalnější.
- **s022:** břeh za ostrůvky byl tráva, teď kamenná dlažba hradu; ostrůvky a voda beze změny.

Znovu se nesoudilo (jedno kolo, bez druhého soudu).

Testy: `src/play` + `src/components/play` 13 464 / 13 466 – dva pády jsou časové limity pod zátěží (`director.test.ts` 92 s, `runner-sections.test.ts` 125 s, STACK_TRACE_ERROR), samostatně 58/58; `tsc` čistý. E2e proti buildu s opravou (server bez čtečky na 3168): `play-shooter` chromium 7/7, `p58a-framing` 48 + 24 + 24 (chromium, Pixel 7, iPhone; zbytek přeskočený podle profilu), `p61-portrait` 19 + 19 na obou telefonech, 0 pádů.

### Nálezy T6 (bez druhého kola)

- **Postava nebo věc malá či nečitelná** (8 řádků, vedlejší výtka): cíle hodu (s050 děti, s088 krabice) stojí malé a daleko; pronásledovatel běžce (s003 Roomba, s008 opice) je za hrdinou nebo pod spodní hranou; hrdina běžce s006 není poznat jako corgi.
- **Kalná scéna** (s037, s002, s006): po opravě je s037 světlejší, hrad v aréně a park ve dvou snímcích s006 zůstávají tmavé.
- **Mechaniky, které hra neumí** (s069 match-3, s022 věž s pohyblivými plošinami, s021 rotující tyče, s035 konec po 0,9 s, s088 prak) – mimo scénu.
- **Náhradní kvádr ve hře ze čtení** (s022) – start scény, jako nález T7 v P61.
- **Bílý kopec za lednicí** v supermarketu běžce (snímek 2 před i po) zůstal; podle tvaru jde o kulisu, ne o zem – neměřeno.

## Zapečetěná brána (T7, 27. 10.)

**Výsledek:** na zapečetěné sadě P62 rychlou hru nezlepšila. „Hrál bych“ má medián 0,515 proti 0,525 u `main` (cíl byl o 0,10 víc), věrnost 0,49 proti 0,57. Hra po čtení je lákavější (0,58 proti 0,545). Aréna v místě, které sedí s větou, si polepšila. Víc ale ztratily tři věty, kde P62 nakreslila zřetelně jiné místo, než věta říká.

Sada otevřená jednou 27. 10. 2026 ve 21:30 UTC na větvi `569aba6f` (`holdout-opened.json`). Větev nafocená do `D:/caches/p62/p62-holdout/` týmž `shots.mjs` a nastavením jako `main` v T1 (`495bbc77`, `D:/caches/p62/main-holdout/`): snímky v 1, 3 a 5 s, desktop 1280 × 720 i Pixel 7, čtečka astra zapnutá, upgrade cesta při focení zablokovaná. 24 z 24 vět bez chyby, hra ze čtení vznikla u 7 vět na obou stranách (tytéž řetězy).

- 23 z 24 rychlých her mají na `main` i větvi totéž id verze, tedy stejnou hru – liší se jen tím, jak scénu kreslí. Jiná je jen p19: T2 zaregistroval krápník, takže role nesou jméno „stalactite“ místo „block“ a „gear“.
- Na větu jeden list (desktop) s řádky `main` rychlá, `main` ze čtení, P62 rychlá, P62 ze čtení – co vzniklo, 2 nebo 4 řádky; pořadí `pure-rand` se seedem 61026.
- Soudce **Codex** (`codex exec`, obrázek jen jako `sheet.png` v prázdném `mkdtemp`), souběh 1, jeden běh, 24 volání, všechny odpovědi platné napoprvé → `result.json`. Před během bylo ze sdíleného denního limitu 50 volání spotřebováno 6. Listy a odpovědi leží v `D:/caches/p62/sheets-holdout/`.
- Dev tabulky výš soudil Claude, tuhle Codex. Srovnávají se jen `main` a větev na týchž listech, ne s čísly T1 a T6.

| Strana | Věrnost | Hrál bych | Vět |
|---|---|---|---|
| `main` rychlá hra | 0,57 | 0,525 | 24 |
| `main` po čtení | 0,585 | 0,545 | 24 |
| P62 rychlá hra | 0,49 | 0,515 | 24 |
| P62 po čtení | 0,58 | 0,58 | 24 |

„Po čtení“ = hra ze čtení, a když nevznikla, rychlá hra. Hra ze čtení sama (7 vět): `main` 0,50 / 0,53, P62 0,58 / 0,59. Průměr rychlé hry (doplněk k mediánu): věrnost 0,467 → 0,456, „hrál bych“ 0,474 → 0,474; „hrál bych“ větev zvedla u 11 vět, u 11 snížila, u 2 nechala.

| Brána | P62 | `main` | Výsledek |
|---|---|---|---|
| G1 rychlá hra: medián „hrál bych“ ≥ `main` + 0,10 | 0,515 | 0,525 (cíl 0,625) | nesplněna |
| G2 rychlá hra: medián věrnosti ≥ `main` | 0,49 | 0,57 | nesplněna |
| G3 po čtení: medián „hrál bych“ ≥ `main` | 0,58 | 0,545 | splněna |
| G4 věta → hratelná: medián větve ≤ `main` + 0,2 s (desktop i telefon) | 3,12 s / 8,87 s | 2,95 s / 8,20 s | nesplněna |
| G5 FPS na telefonu: medián B/A přes scény ≥ 0,95 (oba běhy) | 1,00 / 1,002 | – | splněna |
| G6 bajty modelů první hry na telefonu: medián větve ≤ `main` × 1,25 | 762 KiB | 686 KiB | splněna |
| G7 robot vyhraje, nečinný nevyhraje, přehrání shodné na všech hrách sady | 31 / 31 | – | splněna |

Brány přepočítává `__tests__/result.test.ts` ze skóre po větách v `result.json` (G4–G7 ze surových běhů v `timing`, `fps`, `bytes` a `robot`); prahy má z plánu, ne z výsledku. Celkový verdikt (`result.json` → `verdict`): nesplněny G1, G2 a G4.

### Verdikt: G1 a G2 nesplněny

Rychlá hra P62 není na zapečetěné sadě lákavější ani věrnější než `main`. Podle sady se nic neladilo.

**Které scény P62 vůbec mění** (odvozeno ze specifikace hry – žánr a vzhled místa –, u p04, p08, p18 a p24 ověřeno okem na listu):
- **14 vět se změněnou scénou:** aréna 9 (p01, p02, p05, p06, p07, p11, p13, p15, p23), střelnice 1 (p17), podlaha interiéru v jiném žánru 4 (p03 rytmus, p18 obrana, p19 stohování, p24 běžec). Medián rozdílu P62 − `main`: věrnost +0,005, „hrál bych“ +0,055. Aréna sama: 6 vět nahoru, 3 dolů, medián +0,06 / +0,06.
- **10 vět se stejnou scénou** (p04 závod, p08, p20, p21, p22 běžec venku, p09, p14 chytání, p10, p12 stohování venku, p16 hod): na listu je tatáž hra, jen v jiném okamžiku. Soudce je přesto posunul o −0,10 až +0,09 (medián −0,015 / −0,03). To je rozptyl Codexu na této sadě při jednom běhu.

**Proč medián klesl, i když aréna získala** (odvozeno z pořadí hodnot): medián 24 vět leží mezi 12. a 13. větou. U větve tam padly p23 a p24, obě ztráty; u `main` tam stály p17 a p23 s 0,57.

Ztráty podle výtek soudce, seskupené podle příčiny:
1. **Zřetelně jiné místo, než věta říká** – P62 dělá zvolený interiér nezaměnitelným. Když je zvolený vzhled jen náhradou za místo, které knihovna nemá, nebo výchozím místem žánru, soudce teď jasně vidí špatné místo. `main` kreslil tentýž vzhled méně zřetelně a soudce ho četl jako vhodný.
   - p24 noční trh → supermarket: dlažba bez silnice místo silnice s pruhem, −0,29 / −0,21;
   - p18 fotbalové hřiště v obraně, jejíž místo je výchozí „castle walls“ → hradní dlažba místo trávy, −0,16 / −0,09;
   - p23 pošta → obývák: prkna a gauče místo červené dlažby, −0,08 / −0,07.
2. **Náhradní kvádr hrdiny v prvních snímcích** – p06: soudce píše „hunter appears as a plain block in two screenshots“, −0,06 / −0,07. Na listu p01 a p06 stojí u P62 v 1 a 3 s modrý kvádr, u `main` už model. Proč, se neměřilo: bajty modelů (níž) jsou jen z pěti dev vět, ne z p01 a p06; odvozeno, neověřeno – modely kulis arény z T4 se stahují spolu s hrdinou.
3. **Šum soudce** na stejné scéně: p08 −0,10 / −0,06, p10 −0,08 / −0,08.

Zisky: p02 supermarket +0,14 / +0,15 (regály, nakupující), p07 kavárna +0,11 / +0,07 (stoly), p13 střechy +0,08 / +0,11, p01 obchoďák +0,08 / +0,06, p05 hrad +0,06 / +0,09. Všechno arény, kde vzhled sedí s místem věty.

Po větách, věrnost / hrál bych; „=“ = hra ze čtení nevznikla, po čtení se hraje rychlá hra:

| Věta | `main` rychlá | P62 rychlá | `main` po čtení | P62 po čtení | Scéna P62 | Výtka soudce u rychlé hry P62 |
|---|---|---|---|---|---|---|
| p01 ochranka, krysy, obchoďák v noci | 0,64 / 0,55 | 0,72 / 0,61 | = | = | aréna, obchoďák | strážný, krysy a tmavý interiér obchoďáku s překážkami; postavy hrubé |
| p02 deset krabic cereálií, supermarket | 0,63 / 0,46 | 0,77 / 0,61 | = | = | aréna, supermarket | regály, krabice, nakupující a počítadlo deseti krabic; sbírá se ze země |
| p03 kotě shazuje vázy, obývák | 0,30 / 0,25 | 0,35 / 0,30 | 0,45 / 0,60 | 0,50 / 0,65 | rytmus, obývák | kotě, gauč, lampy a prkenná podlaha; vázy a shazování z polic chybí |
| p04 svářeč, vozíky, továrna aut | 0,61 / 0,59 | 0,58 / 0,55 | = | = | beze změny (závod) | průmyslová silnice a jmenovka svářeče; hrdina vypadá jako auto, vozíky nejsou poznat |
| p05 šašek, obrnění strážci, hradní sál | 0,70 / 0,57 | 0,76 / 0,66 | = | = | aréna, hrad | šašek, obrnění nepřátelé, útoky a kamenné zdivo; spíš nádvoří než sál |
| p06 hledač drahokamů, jeskyně, netopýři | 0,72 / 0,65 | 0,66 / 0,58 | = | = | aréna, jeskyně | drahokamy a jeskyně; netopýři nejasní, hrdina ve dvou snímcích holý kvádr |
| p07 pikolík, hrnky, kavárna | 0,24 / 0,36 | 0,35 / 0,43 | = | = | aréna | stoly a jmenovka pikolíka; aréna vypadá venkovně, sbírané věci abstraktní |
| p08 uklízeč, vozíky, nemocnice | 0,30 / 0,49 | 0,20 / 0,43 | = | = | beze změny (běžec, hřbitov) | zasněžená cesta hřbitovem místo nemocniční chodby, vozíky nejsou |
| p09 farmář, prasata, farma | 0,08 / 0,28 | 0,08 / 0,28 | 0,50 / 0,58 | 0,47 / 0,51 | beze změny (chytání) | postava pod stromy a padající předmět; prasata ani stodola |
| p10 stavitel z písku, medúzy, pláž | 0,20 / 0,20 | 0,12 / 0,12 | 0,86 / 0,80 | 0,85 / 0,78 | beze změny (stohování) | statická šedá písečná scéna s překážkami, bez stavitele a medúz |
| p11 jak, horský průsmyk, balvany | 0,35 / 0,42 | 0,38 / 0,48 | = | = | aréna | jak a náklad; vlci a kvádry na trávě místo hor a padajících balvanů |
| p12 strážce parku, ohně, les | 0,12 / 0,23 | 0,10 / 0,19 | 0,45 / 0,53 | 0,58 / 0,61 | beze změny (stohování) | opakované šedé lesní záběry a pět děr, hašení ohňů není |
| p13 čistič oken, draci, deštivé střechy | 0,68 / 0,46 | 0,76 / 0,57 | = | = | aréna | deštivé střechy, draci, jmenovka a víc překážek; velmi tmavé |
| p14 měsíční vozítko, kameny, meteority | 0,08 / 0,22 | 0,08 / 0,22 | 0,65 / 0,48 | 0,73 / 0,58 | beze změny (chytání) | sad a chytání padajících věcí místo měsíčního vozítka |
| p15 nomád, džbány, poušť | 0,87 / 0,64 | 0,85 / 0,70 | = | = | aréna | nomád, duny a sběr vody; víc překážek, džbány nejasné |
| p16 mořská čarodějnice, ohnivé koule, lodě | 0,76 / 0,61 | 0,75 / 0,59 | = | = | beze změny (hod) | bouřlivé moře a pirátské lodě; čarodějnice a koule malé |
| p17 vydra, električtí úhoři, tůň | 0,57 / 0,64 | 0,54 / 0,59 | = | = | střelnice | vydra a úhoři; přístav s bójemi místo skalní tůně, nepřehledné |
| p18 správce hřiště, krtci | 0,52 / 0,53 | 0,36 / 0,44 | = | = | obrana, hradní dlažba | krtci ano; dlážděné dráhy jako pinball místo fotbalového trávníku |
| p19 jeskyňář, zatopená šachta, krápníky | 0,10 / 0,16 | 0,08 / 0,19 | 0,30 / 0,52 | 0,22 / 0,59 | stohování, továrna | malá postava na šedé průmyslové dráze s jeřáby, žádná voda ani krápníky |
| p20 turista, červený kaňon, kaktusy | 0,64 / 0,70 | 0,70 / 0,79 | 0,55 / 0,48 | 0,62 / 0,57 | beze změny (běžec) | přesvědčivý červený kaňon, kaktusy a skoky; kaktusy stojí, nepronásledují |
| p21 venčitel psů, park, větve | 0,60 / 0,54 | 0,64 / 0,57 | = | = | beze změny (běžec) | deštivá cesta parkem, venčitel a pes; padající větve nejasné |
| p22 plechovka, lisy, vrakoviště | 0,15 / 0,52 | 0,13 / 0,46 | = | = | beze změny (běžec) | lesní cesta místo vrakoviště, žádná plechovka ani lisy |
| p23 štěně, krabice, pošta | 0,57 / 0,65 | 0,49 / 0,58 | = | = | aréna, obývák | pes a souboj; krabice nejasné, dřevěná zařízená místnost vypadá jako domov, ne pošta |
| p24 prodavač, rolety, noční trh | 0,78 / 0,65 | 0,49 / 0,44 | = | = | běžec, supermarket bez silnice | prodavač a tmavý trh; rozházené překážky a mince jako obecný běžec, rolety nejsou |

Hra ze čtení (G3 splněna): ve 3 ze 7 řetězů je P62 po čtení lákavější o 0,08 a víc (p12 +0,08, p14 +0,10, p20 +0,09), u ostatních do ±0,07.

**Co z toho plyne (odvozeno, neměřeno):** dlažba a stěny interiéru pomáhají, jen když interiér sedí s větou. Další krok není víc kulis, ale rozhodnout, kdy vzhled místa kreslit naplno: vzhled převzatý z výchozího místa žánru (obrana = „castle walls“) nebo náhrada za místo bez vlastního vzhledu (pošta, noční trh) by měly zůstat neutrální. Podle sady se nic neladilo; je to podnět pro další plán.

### Robot, nečinný hráč, přehrání (G7)

Všech 31 her, které větev na sadě publikovala (24 rychlých, z toho 7 řetězů, a 7 her ze čtení):
- publikační brána (robot vyhraje, nečinný hráč nevyhraje, dvě přehrání skončí ve stavu běhu robota; u řetězu každé kolo) prošla 31 / 31;
- znovu offline v novém procesu nad publikovaným světem (dočasný `t7-robot.measure.ts` jako v P61, kopie v `D:/caches/p62/t7/`): robot vyhrál 31 / 31, nečinný nevyhrál 31 / 31, přehrání shodná 31 / 31, otisk běhu robota i nečinného shodný se zprávou serveru 31 / 31.

**Beze změny proti `main`:** 24 rychlých her znovu publikovaných na `main` bez čtečky (id verzí shodná se snímky T1 24 / 24) – otisk běhu robota i nečinného je u všech 24 stejný jako na větvi, včetně p19 s jiným jménem role. Kulisy P62 tedy do hry nezasahují. Hry `main` ze čtení z T1 zmizely se serverem (žily v jeho paměti), srovnání proti `main` je proto jen u rychlých her.

### Čas do hratelné hry (G4) – na telefonu nesplněna

`scripts/measure/first-playable-ab.mjs`, 27. 10. 2026 ve 23 h: A = `main` `495bbc77` (worktree `demo-main-2026-10-23`, build z 27. 10. 11 h téhož commitu), B = větev `569aba6f`. Oba `next start` s prázdným úložištěm her, bez čtečky (0 placených volání), servery běžely souběžně (porty 3162 a 3168). Prvních 5 dev vět (`p30/dev.json` [0..4]), 3 běhy na stranu, dvojice A+B těsně po sobě se střídavým začátkem, oba profily skriptu. Hratelných 60 z 60 běhů. Stroj vytížený jinými relacemi, na klid se nečekalo. Surové časy v `result.json` → `timing`, HAR v `D:/caches/p62/t7/ttp-raw/`.

| Profil | `main` medián | P62 medián | rozdíl mediánů | párový rozdíl | Brána ≤ +200 ms |
|---|---|---|---|---|---|
| desktop 1280×720 | 2950 ms | 3115 ms | +165 ms | +165 ms | splněna |
| Pixel 7, CPU 4× | 8204 ms | 8865 ms | +661 ms | −103 ms | nesplněna |

Po větách, medián 3 běhů v ms, `main` → P62:

| Věta | Desktop | Telefon | Telefon, první snímek |
|---|---|---|---|
| s039 zombie shooter in a mall | 2698 → 2844 | 9683 → 9776 | 4862 → 4709 |
| s037 space marine, alien bugs | 2217 → 2782 | 7329 → 7140 | 5176 → 4520 |
| s002 knight, three keys, ghosts | 2950 → 3115 | 7967 → 8865 | 4813 → 4575 |
| s003 hamster, Roomba | 3044 → 3405 | 8923 → 9237 | 5554 → 5805 |
| s006 corgi, sausages, sprinklers | 3362 → 3592 | 8093 → 8127 | 5674 → 5494 |

- Brána platí pro oba profily skriptu (jako v P61) a měří medián všech 15 běhů. Na telefonu ho nesplnila: +661 ms.
- Párový rozdíl je −103 ms a medián rozdílů po větách +93 ms. Medián 15 běhů skáče mezi skupinami vět (s037 kolem 7,1 s, s002 a s006 kolem 8 s, s039 a s003 9–10 s). 8865 ms větve je přesně medián s002.
- Jediný posun ve všech třech bězích je s002 (hrad v aréně): +0,9 s v mediánu, první snímek naopak o 0,24 s dřív. Od prvního snímku do hratelnosti tedy přibylo asi 1,1 s. Odvozeno, neprofilováno: sedí to s pěti modely kulis navíc (níž) a s rozmístěním kulis po hydrataci (T4-R1).
- Desktop: větev pomalejší u všech pěti vět (+146 až +565 ms), medián +165 ms je pod hranicí.

### FPS na telefonu (G5) – splněna

Dva běhy, oba A/B prokládaně scénu po scéně, `main` `495bbc77` proti větvi `569aba6f`, tytéž servery jako G4. Stroj byl vytížený, na klid se nečekalo. Brána: medián poměrů B/A přes scény (poměr = medián FPS větve / medián FPS `main` ve scéně) ≥ 0,95 v každém běhu. Surová čísla v `result.json` → `fps`.

| Běh | Scén | Medián B/A | Brána ≥ 0,95 |
|---|---|---|---|
| `e2e/play-perf.spec.ts @measure`, telefonní profil specu (Moto G Power, 412 × 823, CPU 4×, Fast 4G), 3 kola | 6 | 1,00 | splněna |
| `scripts/play-look-shots.mjs perf --vs`, Pixel 7, CPU 4×, 22 žánrů + 3 dev scény, 3 opakování | 25 | 1,002 | splněna |

- Spec nemá profil Pixel 7, měří jen svou emulaci Moto G Power (jako v P61). Proto druhý běh na Pixel 7 nad 22 žánry (nástroj P54B) a třemi dev scénami, které P62 mění nejvíc: střelnice v obchoďáku (s039), aréna na hradě (s002) a běžec v supermarketu (s003; sada `D:/caches/p62/t7/perf-set.json`).
- Metrika specu (FPS z mediánu délky snímku) stojí ve 34 z 36 běhů obou stran na stropu 60 Hz (mimo: `grid-collect` 2. kolo, `main` 59,5, větev 30,0), pozná tedy jen pokles pod strop. Scéna `drive` padla v 1. kole na obou stranách (`play-perf.spec.ts:192`, sonda specu řetěz nespustí – stejná mezera jako v P61) a v dalších kolech se nepouštěla.
- Nejhorší scény druhého běhu: `g-agar` 0,886 (volání 54 → 56, rozptyl), **`d-s039` střelnice v obchoďáku 0,889** – 42,3 → 37,6 FPS, větev nižší ve všech třech opakováních (41,2–43,0 proti 34,9–38,6) při méně voláních (48 → 39). Odvozeno podle poznámky „pokles bez volání = procesor“: práce procesoru za snímek ve scéně s kulisami a zvětšenými nepřáteli (T4, T5); neprofilováno. Dál `g-timing` 0,906 a `g-arena` 0,933 (volání 70 → 83, kulisy arény z T4). Čtyři scény jsou pod 0,95, medián přes 25 scén drží 1,002.
- Kreslené snímky (`drawnFps`, snímky, ve kterých se opravdu kreslilo) v prvním běhu: `grid-collect` 36,3 → 27,3, ostatní scény v rozptylu. Brána je postavená na FPS, ne na kreslených snímcích; zapsáno jako pozorování.

### Bajty modelů první hry na telefonu (G6) – splněna

`D:/caches/p62/t7/har-bytes.mjs`: Pixel 7 s CPU 4×, čerstvý kontext (prázdná cache) na každé načtení, HAR od navigace, dokud po plátně 6 s nezačalo ani neviselo stahování modelu (strop 60 s, nedosažen). Bajty = přenesená velikost všech `.glb` v HAR. Tytéž dev věty a servery jako G4, rychlá hra publikovaná na obou stranách, 2 běhy na stranu prokládaně. Obě opakování daly bajt na bajt totéž.

| Profil | `main` medián | P62 medián | B / A | Brána ≤ 1,25 |
|---|---|---|---|---|
| Pixel 7, CPU 4×, první hra, prázdná cache | 686 KiB | 762 KiB | 1,11 | splněna |

| Věta | Modely `main` → P62 | KiB `main` → P62 |
|---|---|---|
| s039 zombie shooter in a mall | 17 → 17 | 530 → 530 |
| s037 space marine, alien bugs | 19 → 19 | 498 → 498 |
| s002 knight, three keys, ghosts | 22 → 27 | 686 → 840 |
| s003 hamster, Roomba | 37 → 37 | 762 → 762 |
| s006 corgi, sausages, sprinklers | 36 → 36 | 826 → 826 |

- Modely přibyly jen hradu v aréně (+5 modelů, +154 KiB, +22 %). Kulisy střelnice v obchoďáku (T4) jsou tytéž modely, které už stojí na okraji. Dlažba interiéru (T6) je textura kreslená v prohlížeči, nic se nestahuje.
- Medián přes věty leží u každé strany na jiné větě (`main` s002, P62 s003), proto 1,11, i když se změnila jen jedna věta.
- Celkem přenesených bajtů (nejen modely): s039 a s037 +101 KiB, s002 +254 KiB (z toho modely 154 KiB), s003 a s006 +4 KiB. Rozdíl mimo modely jsou bloky JavaScriptu; jejich jména se mezi buildy liší, po souborech se nesrovnávalo.
- Prvním pokusem měřidla s oknem ticha od navigace vyšlo jedno načtení `main` s nulou modelů – na CPU 4× začalo stahování modelů později než 6 s po navigaci. Okno se teď počítá od plátna a čeká na první model; v tabulce je jen druhý pokus.

### Testy

- **Vitest** cíleně `src/play`, `src/components/play`, `src/app/api/play`, `evals/play/p62` (JSON reporter, po skončení všech měření): 14 025 / 14 025 zelených, žádný časový limit. `tsc` čistý.
- `__tests__/result.test.ts` (11 případů) přepočítá brány z `result.json`. Rozbité schválně: G3 v `result.json` přepsaná na nesplněnou a G2 v README na splněnou – každé zčervená test „records each gate verdict“.
- **E2E** proti buildu větve (`next start` bez čtečky, prázdné úložiště, `FALLBACK_SMOKE_URL`, `--grep-invert @measure`): 115 prošlo, 0 červených, 120 přeskočil spec podle profilu.
  - `chromium`: `play-shooter` 7, `play-phone` 4, `p58a-framing` 48 (+ 24 přeskočených).
  - `pixel7-touch` a `iphone-touch`: `play-phone` 4 a `p58a-framing` 24 (+ 48 přeskočených) na každém.
  - `play-shooter` a `play-perf` v dotykových projektech konfigurace nemá. `play-perf` má jen test `@measure`; ten běžel jako měření FPS (G5).
- Po bězích `git status` v obou worktree bez přepsaných artefaktů.

## Místo z věty (fáze 4, od 28. 10.)

Brána T7 neprošla hlavně kvůli špatně zvolenému místu. Fáze 4 nejdřív změří, jak často rychlá hra kreslí jiné místo, než věta jmenuje (T9), pak výběr místa opraví (T10) a změří znovu na nové zapečetěné sadě (T12). Srovnávací `main` je od T8 P63 (`c1dfd552`); větev ho má sloučený (`d67dd4ce`).

### Zapečetěná sada B (T9)

`holdout-b.json` – 24 nových anglických vět, napsaných 28. 10. 2026 před jakoukoli opravou místa, jen z podstatných jmen (žádná cizí hra). Každá věta jmenuje místo:
- **8 interiérů:** knihovna, sushi restaurace, byt, školní záchody, zlatý důl, kobka, opera, laboratoř;
- **8 venkovních míst:** ranč, skalní útes, zeleninová zahrada, aquapark, nad mraky, kemp u jezera, zoo, otevřené moře;
- **8 dvouslovných míst, pro která knihovna sadu nemá:** rybí trh, nádraží, kluziště, golfové hřiště, bowling, autoservis, skatepark, cukrárna.

Slovesa míchají žánry jako sada T1 (chytání, sběr, útěk, střelba, hod, skládání, běh) – záměr při psaní, žánr se neověřoval, aby se věty nehrály. Žádná věta se neshoduje, ani skoro (podíl společných slov ≥ 0,3), se sadou T1, žádnou sadou P61 a P63 ani další známou sadou (`__tests__/seal.test.ts`). Nejbližší dvojice přes všech 58 sad vět v `evals/play` je 0,27 („porter … train station“ proti „Snow falling … train station“ z `p51/holdout.json`). Čtyři věty, které se s dřívějšími sadami potkaly (hasič a koťata, rytíř a spící draci, kovboj a dobytek, pastevecký pes), se přepsaly ještě před zapečetěním. Věty se nehrály ani nečetly kódem.

SHA-256 nad LF bajty: `d62f5010f3dcabe025f4cb9f74449095273a51a11e41c04e7a03312d62719ece` (`seal.ts` → `P62_HOLDOUT_B_SHA256`). Otevře se jednou v T12 (`holdout-b-opened.json`); nic se podle ní neladí.

### Audit místa (T9, `place-audit.json`)

**Co se měří.** 268 otevřených vět: 220 vět auditu T1 (s dev větami P62) a otevřené holdouty `p61/holdout.json` a `p62/holdout.json`. Sada B se nečte. U každé věty ruční štítek (`place-labels.json`): místo, jak ho věta jmenuje, a sady, ve kterých by ho divák poznal. Místo bez vlastní sady má ve štítku nejbližší venkovní nebo neutrální sadu, interiér jen tehdy, když věta interiér jmenuje (podle plánu: noční trh → město, fotbalové hřiště → louka, pošta → město). Proti tomu sada, kterou kreslí rychlá hra z dveří `/api/play/games` (`lookOf`, recept auditu T1). Štítky vznikly z textu věty, ne z výsledku kódu.

**Výsledek na větvi po sloučení P63** (`d67dd4ce`): 206 vět místo jmenuje, **180 trefí, 26 ne** (13 %). Cíl T10: nejvýš 13 špatných a žádná ze 180 správných se nezhorší.

| Třída | Vět | Příklady (místo → kreslená sada) |
|---|---|---|
| Místo žádná sada nezná, scéna kreslí zálohu (louka nebo výchozí místo žánru) | 13 | kavárna → louka (2×), sklep, pohovka, obří hodiny, muzeum, taneční sál, hora, jídelna → louka; lekníny a deka na piknik → pláž; hotel → poušť; vrakoviště → les |
| Dvouslovné místo čtené po slovech | 7 | noční trh → supermarket, pošta → obývák, nemocniční chodba → hřbitov, školní hřiště a kouzelnická škola → obývák, kráterové pole → louka, plovoucí trh v mracích → supermarket |
| Místo přebilo jiné slovo věty | 5 | hrad + sněhové koule → sníh, okap + papírová loďka → oceán, cirkus + plážový míč → pláž, přespání + duch → hřbitov, táborák + „marshmallows“ → vesmír (regulární výraz chytí „mars“ uvnitř slova) |
| Cizí interiér místo venkovního místa | 1 | fotbalové hřiště v obraně → hrad (výchozí místo žánru „castle walls“) |

Třídu dává první pravidlo, které sedí (pořadí v hlavičce `place-audit.mjs`). 62 vět místo nejmenuje („Explain quantum physics“, postavy bez prostředí) a do počtu nejdou. Nová sada podle plánu jen pro místo, které jmenuje ≥ 3 % otevřených vět (≥ 7 z 206): z 26 špatných jmenuje stejné místo nejvýš dvojice (kavárna), takže T10 žádnou novou sadu nedělá.

`__tests__/place-audit.test.ts` drží, že audit čte jen otevřené sady, každá věta má právě jeden štítek se sadami, které existují, třídy dávají pravidla z hlavičky, a že řádky i počty v `place-audit.json` vycházejí ze štítků a kreslené sady.

## Útrata

Čtení věty (astra) při focení dev a zapečetěné sady v T1: **1,09 USD** za 36 volání (`shots.mjs spend --usage-log D:/caches/p62/usage-t1.jsonl` → 1,0946).

T6: **0,45 USD** za 15 volání (`--usage-log D:/caches/p62/usage-t6.jsonl` → 0,4508, strop serveru 1 USD) – focení větve na dev 0,36 USD za 12 volání, snímky po opravě (4 věty) 0,09 USD za 3 volání.

T7: **0,74 USD** za 24 volání (`--usage-log D:/caches/p62/usage-t7.jsonl` → 0,7393, strop serveru 1,5 USD) – focení větve na zapečetěné sadě. Čas do hratelné hry, FPS, bajty a e2e běžely bez čtečky.

Celkem 2,28 USD (1,0946 + 0,4508 + 0,7393) ze stropu plánu 4 USD; zbývá 1,72 USD.

## Jak to zopakovat

```
node --env-file=<worktree P58B>/.env.local <demo-main>/evals/play/p61/shots.mjs serve --port 3162 --usage-log D:/caches/p62/usage-t1.jsonl --cap-usd 2
node <demo-main>/evals/play/p61/shots.mjs shoot --set evals/play/p30/dev.json --range 0..11 --out D:/caches/p62/main-dev --label main --base http://127.0.0.1:3162
node evals/play/p61/judge.mjs --shots main=D:/caches/p62/main-dev --out evals/play/p62/baseline-dev.json --judge claude --runs 2 --sheets D:/caches/p62/sheets-dev
node <demo-main>/evals/play/p61/shots.mjs shoot --set evals/play/p62/holdout.json --out D:/caches/p62/main-holdout --label main --base http://127.0.0.1:3162
node evals/play/p62/audit.mjs
# T6: větev na dev (build větve, server na 3168)
node --env-file=<worktree P58B>/.env.local evals/play/p61/shots.mjs serve --port 3168 --usage-log D:/caches/p62/usage-t6.jsonl --cap-usd 1
node evals/play/p61/shots.mjs shoot --set evals/play/p30/dev.json --range 0..11 --out D:/caches/p62/p62-dev --label p62 --commit 6beb49d3 --base http://127.0.0.1:3168
node evals/play/p61/judge.mjs --shots p62=D:/caches/p62/p62-dev --out evals/play/p62/after-dev.json --judge claude --runs 2 --sheets D:/caches/p62/sheets-p62-dev
# T6 po opravě: jen dotčené dev věty (s039, s037, s003, s022 v D:/caches/p62/t6-set.json)
node evals/play/p61/shots.mjs shoot --set D:/caches/p62/t6-set.json --out D:/caches/p62/t6-after --label p62-t6 --base http://127.0.0.1:3168
# T7: zapečetěná brána (sada už otevřená – holdout-opened.json; podruhé ji openSealedOnce odmítne)
node --env-file=<worktree P58B>/.env.local evals/play/p61/shots.mjs serve --port 3168 --usage-log D:/caches/p62/usage-t7.jsonl --cap-usd 1.5
node evals/play/p61/shots.mjs shoot --set evals/play/p62/holdout.json --out D:/caches/p62/p62-holdout --label p62 --commit 569aba6f --base http://127.0.0.1:3168
node D:/caches/p62/t7/fetch-games.mjs shots D:/caches/p62/p62-holdout http://127.0.0.1:3168 D:/caches/p62/p62-holdout/games
node evals/play/p61/judge.mjs --shots main=D:/caches/p62/main-holdout,p62=D:/caches/p62/p62-holdout --out D:/caches/p62/t7/judge.json --judge codex --runs 1 --sheets D:/caches/p62/sheets-holdout
# T7 bez čtečky: main (demo-main) na 3162, větev na 3168, obě PLAY_STORE_DIR=<prázdný adresář> node node_modules/next/dist/bin/next start -p <port> -H 127.0.0.1
node scripts/measure/first-playable-ab.mjs D:/caches/p62/t7/ttp-config.json
node D:/caches/p62/t7/har-bytes.mjs http://127.0.0.1:3162 http://127.0.0.1:3168 2 D:/caches/p62/t7/har2
node D:/caches/p62/t7/fps-ab.mjs http://127.0.0.1:3162 http://127.0.0.1:3168 3 D:/caches/p62/t7/fps runner,arena,grid-collect,glide,walker,ball
node scripts/play-look-shots.mjs perf --base http://127.0.0.1:3162 --out D:/caches/p62/t7/look-perf-main.json --vs http://127.0.0.1:3168 --out-vs D:/caches/p62/t7/look-perf-p62.json --repeats 3 --set genres,../../../../../../../../caches/p62/t7/perf-set
node D:/caches/p62/t7/fetch-games.mjs publish evals/play/p62/holdout.json http://127.0.0.1:3162 D:/caches/p62/t7/main-quick-games
P62_GAMES_DIRS="D:/caches/p62/p62-holdout/games;D:/caches/p62/t7/main-quick-games" npx vitest run --config vitest.measure.mts evals/play/p62/t7-robot.measure.ts   # soubor dočasně z D:/caches/p62/t7/
node D:/caches/p62/t7/compose-result.mjs <worktree> '{"calls":24,"usd":0.7393}'
# T9: audit místa (bez serveru a bez čtečky); --list vypíše věty bez štítku
node evals/play/p62/place-audit.mjs
```

Server jen jeden proces naráz, zastavit podle PID z prvního řádku.
