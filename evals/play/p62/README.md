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

SHA-256 nad LF bajty: `7863a64004efbc746fbec880a06f5ec04c16d114e32153c60541e4c413ca99a9` (`seal.ts`). Otevře se jednou v T7; nic se podle ní neladí.

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

## Útrata

Čtení věty (astra) při focení dev a zapečetěné sady v T1: **1,09 USD** za 36 volání (`shots.mjs spend --usage-log D:/caches/p62/usage-t1.jsonl` → 1,0946).

T6, focení větve na dev: **0,36 USD** za 12 volání (`--usage-log D:/caches/p62/usage-t6.jsonl` → 0,3626, strop serveru 1 USD).

Celkem 1,46 USD ze stropu plánu 4 USD; zbývá 2,54 USD.

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
```

Server jen jeden proces naráz, zastavit podle PID z prvního řádku.
