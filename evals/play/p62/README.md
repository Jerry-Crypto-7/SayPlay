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

## Útrata

Čtení věty (astra) při focení dev a zapečetěné sady v T1: **1,09 USD** za 36 volání (`shots.mjs spend --usage-log D:/caches/p62/usage-t1.jsonl` → 1,0946). Strop plánu 4 USD; zbývá 2,91 USD.

## Jak to zopakovat

```
node --env-file=<worktree P58B>/.env.local <demo-main>/evals/play/p61/shots.mjs serve --port 3162 --usage-log D:/caches/p62/usage-t1.jsonl --cap-usd 2
node <demo-main>/evals/play/p61/shots.mjs shoot --set evals/play/p30/dev.json --range 0..11 --out D:/caches/p62/main-dev --label main --base http://127.0.0.1:3162
node evals/play/p61/judge.mjs --shots main=D:/caches/p62/main-dev --out evals/play/p62/baseline-dev.json --judge claude --runs 2 --sheets D:/caches/p62/sheets-dev
node <demo-main>/evals/play/p61/shots.mjs shoot --set evals/play/p62/holdout.json --out D:/caches/p62/main-holdout --label main --base http://127.0.0.1:3162
node evals/play/p62/audit.mjs
```

Server jen jeden proces naráz, zastavit podle PID z prvního řádku.
