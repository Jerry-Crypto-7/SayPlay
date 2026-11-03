# P68 – pět nových her z jiných pohledů

P68-I (integrace) je jediný pruh, který mění sdílené soubory. T1 postavil kostru: pět her je v každém sdíleném
registru jako `staged`, rozhraní jsou zmrazená a hra se uživateli neukáže, dokud ji úloha „zapoj X“ v P68-I nezapne.
Kategorie P68-V / P68-F / P68-S staví hry jen ve svých souborech (seznam níže).

## Hry a kategorie

| Hra | Kategorie (plán) | Vstup | Povolené pohledy | Adresář předání |
|---|---|---|---|---|
| `stunt` – závod s triky a troskami | `vozidla-sport` (P68-V) | `steer` | `chase` | `vozidla-sport/integration.md` |
| `minigolf` | `vozidla-sport` (P68-V) | `throw-rig` | `shoulder`, `top` | `vozidla-sport/integration.md` |
| `railfps` – střelnice z očí na kolejích | `prvni-osoba` (P68-F) | `genre` (vlastní dotykový adaptér) | `first` | `prvni-osoba/integration.md` |
| `buildshift` – směna se stavbou obchodu | `stavba` (P68-S) | `lanes` s buňkou v ose (`cellAxisAt`) | `top` | `stavba/integration.md` |
| `drawsave` – kresli a zachraň (volitelná) | `stavba` (P68-S) | `genre` (vlastní dotykový adaptér) | `side` | `stavba/integration.md` |

## Soubory předané kategoriím

Každá hra `<id>` (kategorie mění jen tyto, plus své testy a fixtures a `evals/play/p68/<kategorie>/**`):

- `src/play/genre/<id>.ts` – modul žánru (`stagedGenre`); kategorie smí přepnout na `ready` a psát `cues`.
- `src/play/arcade/pieces/<id>.ts` a `<id>-bot.ts` – generátor, pravidla, ovládání a robot (kostry).
- `src/components/play/arcade/genres/<id>/<Id>Scene.tsx` – scéna (zatím podlaha); `railfps` a `drawsave` navíc
  `<Id>Touch.tsx` (dotykový adaptér, props `{ session }`, volá jen `session.press` / `session.hold`).
- `e2e/play-<id>.spec.ts` – e2e hry (zatím jeden `test.skip`); projekty `chromium`, `pixel7-touch`, `iphone-touch`.
- `evals/play/p68/<kategorie>/integration.md` – předání podle `integration-template.md`; značka `p68-ready: <id>`
  (HTML komentář) až když je hra hotová.

## Zmrazená rozhraní (T1)

- `src/play/genre/p68-contract.ts` – `P68_GENRES`, `P68_INPUT`, `P68_VIEWS` (další pohled jen přes `integration.md`
  a zapojení), `RAILFPS_YAW_STEPS = 16` (osa ↔ `yawStep` −16..16, adaptér posílá jen hodnoty z `RAILFPS_AXES`, slot
  `RAILFPS_SLOTS.yawStep` v celočíselném stavu hry, kamera ho jen sleduje, mimo hash), `STUNT_DEBRIS_MAX = 24`,
  `DRAWSAVE_STROKE` (buňky mřížky v ose s `HOLD` po dobu tahu), `P68_MAX_TICKS = 5400`. Nastavení solveru Rapieru
  se nemění.
- Tvar vstupu `ArcadeInput { buttons, axis }`, záznam, `packInputs` a serverový replay Dare se nemění.
- `GENRE_COMPILER_VERSION = 'genre.v7'` (`P68_GENRE_VERSION`). Nové hry a sémantika osy natočení jen od `genre.v7`
  (`genreAtLeast`); staré žánry pod `genre.v7` hrají stejně. Otisk 24 žánrů na `genre.v6` z `688d989d` drží
  `src/play/arcade/__tests__/p68-hash.test.ts` nad `hash-baseline.json` (posunutý seed jedné buňky test shodí – ověřeno).
- Brány: `gates.json` (G1–G7, prahy pro T15), požadované akce na hru: `assertions.json` (nad stopou stavu, ne nad
  efekty pravidel).

## Brána aktivace

Hra je neviditelná, dokud je ve všech třech množinách: `ROUTE_PENDING` (`src/play/genre/classify.ts`, klasifikátor
a rychlá hra), `DIRECTOR_PENDING` (`src/play/director/answer-schema.ts`, režisér) a `READER_PENDING`
(`src/play/read/schema.ts`, čtečka), a její ovládání v `STAGED_CONTROLS` (`src/play/spec.ts`). Odebírá ji jen úloha
„zapoj X“ v P68-I. `src/play/genre/__tests__/p68-staged.test.ts` podvrhne moduly všech pěti her jako hotové (`ready`
a narážky) a hlídá, že je přesto nevidí klasifikátor (věty P30, P66 a P68 dev), prompt ani schéma režiséra a prompt
čtečky.

## Věty

- `dev.json` – 40 vět (8 na hru); smí se na nich ladit.
- Zapečetěná sada – 105 vět (15 na hru, 30 obecných přes ≥ 10 dosavadních žánrů) **mimo repo**:
  `D:/caches/p68/sealed/holdout.json` (kopie `F:/Backups/Hackaton/2026-11-01/p68-holdout.json`). V repu je jen otisk
  `P68_HOLDOUT_SHA256` v `seal.ts`: `f24fadb05ce96ae1a14816eef66d751ddd41ea3eeedc07a4f43f4139ffd43c61`. Neladí se na ní; otevře ji jednou T15
  přes `openSealedOnce`. Test pečeti (`__tests__/seal.test.ts`) hlídá otisk a složení, kde soubor existuje, a vždy
  dev sadu proti všem známým sadám.

## Rozhodnutí a odchylky (T1)

- **`READER_PENDING` přidán do brány aktivace.** Plán jmenoval jen `ROUTE_PENDING` a `DIRECTOR_PENDING`, ale čtečka
  čte `ready` režimy z modulů sama (`READY_GENRE_MODES`); bez třetí brány by hra přepnutá kategorií na `ready` vešla
  do promptu čtečky. Test neviditelnosti to hlídá.
- Mimo seznam souborů plánu: `src/play/intent/contract.ts` (akce `stunt|putt|railshoot|shopbuild|drawwall` pro
  `STAGED_PRESETS`), `e2e/p61-portrait.spec.ts` a `e2e/p64-cells.ts` (P68 buňky vynechané, dokud hra nehraje),
  `src/play/arcade/__tests__/hero-animals.test.ts`, `src/play/genre/__tests__/doubles.ts`.
- VR `input-map.ts` nemá větev pro vstup `genre`: kostra je ve VR `desk`; vlastní VR vstup přijde se zapojením.
  `xr/__tests__/input-map.test.ts` a `modes.test.ts` hry z `ROUTE_PENDING` vynechají – výjimka zmizí sama, jakmile
  zapojení hru z brány odebere, a test pak VR vstup i živou buňku vyžádá.

## `genre.v6` → `genre.v7`: co se přemrazilo a proč (T1)

- **Testy, které pinovaly `genre.v6` jako současnou verzi**, pinují `genre.v7` (důvod: nové hry jsou od T1 `genre.v7`):
  `pacing-template`, `p51-assembly-runner`, `p51-dead-time`, `p52-fight-balance`, `arrows`, `steal`, `p66-staged`
  (tam navíc 24 žánrů = žánry před P68 a `STAGED_PRESETS` bez žánru P66 – kostry P68 v něm být mají).
- **Fixtures P66** (`e2e/fixtures/p66-{hole,sort,survivor}-spec.json`) zůstávají uložené hry `genre.v6` – drží je otisk
  `p68-hash.test.ts`. Testy `hole`, `sort`, `survivor` je porovnají s překladem orazítkovaným `genre.v6`.
- **Zlaté výstupy P41** (`p41/golden/genres.json`) přemrazené `freeze.measure.ts`: pohnula se jen verze a otisk specu,
  0 z 814 otisků světa; `replays.json` beze změny.
- **Semínko nové hry** se počítá z celého specu včetně verze (`seedFrom` v `_publish.ts`), takže stejná věta pod
  `genre.v7` dostane jiné semínko než pod `genre.v6`. Uložené hry mají své semínko a hrají stejně. Proto otisk P64
  (`p64/hash-baseline.json`) přepsán: 4 buňky (`voyage`, `slice`, `crowd`, `merge`) mají nové semínko, robot dál
  vyhrává a nečinný prohrává; ostatní beze změny.
- **Obtížnost P41** (`p41/difficulty.json`) přeměřená `difficulty.measure.ts`: otisky specu nové; 4 profily ze 134 mají
  jiný počet výher (`arena.collect` začátečník 10→11, `arena.fight` začátečník 9→6 a pokročilý 19→20, `defense`
  začátečník 11→9). Sonda ověřila, že razítko `genre.v7` hraje na těchto buňkách všech 20 semínek obou profilů
  bit po bitu jako `genre.v6` – staré řádky byly zastaralé už na `688d989d` (P66 přeměřil jen své řádky), ne posun
  způsobený T1.

## T4 – protokol měření času

- `first-playable-ab.mjs` má v souhrnu `gate`: `failedTotal` (selhání A i B), `pass` jen při 0 selháních, mediánu B
  ≤ 3 000 ms (desktop) a párovém rozdílu ≤ 200 ms (desktop i pixel7-cpu4). Neměřený profil bránu shodí.
- Každý běh má vlastní prohlížeč i kontext (žádná sdílená cache), páry AB/BA beze změny.
- Sonda uzná hratelnost na HUD arkády jen když po vstupu vzroste `data-inputs` i `data-tick`; samotná změna plochy
  nestačí. Cizí weby dál podle plochy.
- R2: mřížkové hry (`Hud.tsx`) `data-inputs` nemají; sonda jejich HUD vynechá a soudí je plochou jako před T4
  (test `?grid=1`).
- Testy: `first-playable-ab.test.ts`, `time-to-playable.test.ts` (fixture `hud-game.html`). mutationStatus: pass.

## T3 – brána FPS na emulovaném telefonu

- `e2e/play-perf.spec.ts` `@p68-fps`: hra z ručního specu `e2e/fixtures/p68-<id>-spec.json` (bez něj přeskočeno),
  robot hraje ukázkou z karty pauzy 20 s, sonda měří intervaly rAF. Tvrdě: medián ≥ 40 FPS, p95 intervalu
  ≤ 33,3 ms + 0,5 ms (dva snímky 60 Hz časovač čte jako 33,3–33,4 ms; bez tolerance by o hře se ztraceným snímkem
  rozhodoval šum). Výsledky po hře a projektu se surovými intervaly a GPU do `fps.json`.
- Projekty: `pixel7-touch` (Chromium, CPU ×4) hradí; `play-perf` je v jejich `testMatch` a `@measure` v nich vyřazuje
  `grepInvert` (projektový `grep` by vyřadil všechny ostatní spec soubory projektu).
- **Odchylka: `iphone-touch` jen zapisuje, nehradí.** WebKit na tomto stroji dal hotové hře `p66-arrows` 18–19 FPS
  (p95 81–112 ms), zatímco Chromium s CPU ×4 tutéž hru drží na 59,9 FPS. Měří hostitele, ne hru; tvrdá brána by
  shodila každou hru. iPhone změří fyzicky P59′.
- Ověření 1. 11. (stroj vytížený na ~90 % jinými relacemi): kontrola `P68_FPS_FIXTURES=p66-arrows` na `pixel7-touch`
  zelená (59,9 FPS, p95 33,3 ms); tatáž s `P68_FPS_SLOW_MS=60` (každý snímek +60 ms) červená (12,0 FPS, p95 117 ms).
  Při jiném měření téže hry vyšlo p95 50 ms – p95 kolísá se zátěží stroje, červenou p95 u nové hry proto ověřit
  prokládaně s kontrolou `p66-arrows`; je-li červená i kontrola, je to stroj.

## T6 – sdílení, Dare a přehrání

- `src/app/api/play/__tests__/p68-roundtrip.test.ts`: hra s ručním specem `e2e/fixtures/p68-<id>-spec.json` projde
  publikací, `/play/<id>`, výzvou Dare i dvojím přehráním se stejným výsledkem, skóre a hashem; bez specu nebo
  s kostrou modulu `it.skip` s důvodem. Totéž kolo jede jako kontrola na ručním specu `p66-arrows`.
- Strop těla 64 kB, nejhorší stopa za 90 s: railfps 64 870 B (FIRE každý druhý tik), drawsave 58 937 B (1 000 buněk).
- **Pozor railfps:** natáčení i střelba v každém tiku = 67 570 B a dveře výzvu odmítnou (413) – test to drží.
- `e2e/play-share.spec.ts`: odkaz výzvy nové hry → dohrát → výsledek v `chromium` i `pixel7-touch`; bez specu
  přeskočeno.

## T5 – herní aserce nad stopou stavu

- `src/play/arcade/gameplay-assert.ts`: `traceRun` přehraje svět s robotem hry, nečinným hráčem nebo slabým robotem
  (`novice`) a po každém tiku uloží kopii stavu jádra, vstup, `yawStep` a výsledek. Efekty pravidel (`win`, `score`)
  do stopy nejdou; výsledek běhu je důkaz jen pro požadavky na výsledek.
- `assertions.json` dostal ke každé větě `expect` strojové pole `check` (próza beze změny). Konvence, které kontroly
  čtou: cíl = role `goal`, trosky = fyzikální nehráčská tělesa, míček = `FLAG.ball`, držák natočení = model
  `railfps_rig`, chráněné tělo = hráč. Kategorie, které je nedodrží, dostanou červenou bránu s důkazem v textu.
- `scripts/measure/gameplay-gate.mjs <specs.json> [--out]` → po hře a větě `win`, `lose`, `actions`, `failed`;
  pád překladu nebo běhu se počítá do jmenovatele `n`.
- Testy na ručních světech bez nových her (8): podvržené `win` bez průjezdu cílem neprojde `crosses-finish`, stojící
  `yawStep` neprojde `aims`, vyhrávající nečinný hráč shodí `idle-loses`, ke každému kladný protějšek.
  mutationStatus: pass – `crosses` čtoucí výsledek, `distinctYaw` čtoucí vstup místo stavu a `outcome` bez rozlišení
  výhry a prohry shodí každý svůj test.

## T7 – měřicí kniha, součet stropů, rezerva pro porotu

- **Měřicí kniha** `scripts/measure/eval-ledger.mjs`: placený měřicí běh jen když `WORLDSMITH_SPEND_STORE_PREFIX`
  končí `-eval` a není produkční předponou (`PLAY_PROD_SPEND_PREFIX`, bez ní `worldsmith:spend`) a
  `PLAY_EVAL_SPEND_CAP_USD` je kladná částka; jinak `fast-only` s důvodem. `p61/shots.mjs serve` pak spustí server
  bez čtečky a bez klíče (strop čtečky v placeném režimu = menší z `--cap-usd` a měřicího stropu; kniha jde do
  `WORLDSMITH_SPEND_STORE_*`, hry zůstávají v paměti), `p58e/live.mjs` skončí kódem 2 a pošle jen na místní
  `shots.mjs serve` (vzdálený `--base` odmítne – platí server, ne klient; nález review).
- **Součet stropů** v `scripts/cloud/check-env.mjs`: režisér + záloha + čtečka (+ skripty při `PLAY_SCRIPTS=on`)
  ≤ `PLAY_TOTAL_SPEND_CAP_USD`, na setiny; chybějící celkový strop, chybějící nebo prázdné `KV_REST_API_*` a vadná
  rezerva shodí kontrolu se jménem proměnné. `env.production.example` má nové proměnné prázdné – bez hodnot od
  majitele (P59′) vzor kontrolou neprojde, a to schválně.
- **Rezerva pro porotu** v `src/server/spend-cap.ts`, jen v knize režiséra: do `PLAY_JUDGING_FROM` (ISO datum, hodiny
  serveru) strop − `PLAY_JUDGING_RESERVE_USD`, od data celý. Bez proměnných beze změny; překlep drží celý strop
  (veřejný provoz hraje rychlou hru), nikdy ho neuvolní.
- Testy: `cloud-check-env.test.ts`, `spend-cap-reserve.test.ts`, `eval-ledger.test.ts` – 88/88.
  mutationStatus: pass – 10 úmyslných chyb (přípona `-eval`, produkční předpona, kladný strop, čtečka v součtu,
  součet přesně na stropu, prázdné KV, strop skriptů, datum rezervy, držení rezervy, bez proměnných) zabil každou
  její test.
- Review (security-reviewer): bez blokujícího nálezu; jediný nález (brána `live.mjs` hlídala klienta) opravený.

## T2 – štítky žánrů, stráž žánru a výchozí stav `main`

- **Štítky** `genre-labels.json`: 29 typů (24 žánrů + 5 nových her popsaných slovy, bez id z kódu), 606 vět
  (`p30/test-200` + otevřené sady), `claude -p` v 31 dávkách po 20, souběh 1, 0 selhání. Holdout P68 neštítkovaný.
  Všech 40 dev vět P68 dostalo jako `best` svou hru.
- **Stráž** `genre-route.mjs` nad `main` 688d989d → `route-main.json`: `wrongRate` sada 200 **0,366** (64 ze 175,
  25 vět bez hry), otevřené sady **0,345** (138 ze 400). `wrong` = věta má `best` a žánr není v `acceptable`;
  věty bez hry se nepočítají (test `genre-route.test.ts` drží definici na třech ručních větách).
- **Dosah nových her na sadě 200 je malý:** 14 vět (7 %) má novou hru v `best` nebo `acceptable`. stunt 1 + 3
  (dnes arena 2, voyage 2), minigolf 0, railfps 0 + 2 (voyage 2), buildshift 0 + 4 (arena 2, quest 1, rhythm 1),
  drawsave 3 + 1 (quest 2, arena 1, rhythm 1; 2 ze 3 `best` jsou dnes chybně). Na otevřených sadách (s 40 dev
  větami) 8–9 `best` na hru; přešly by hlavně z voyage (stunt), arena (minigolf), shooter (railfps), quest
  (buildshift) a arena (drawsave). Stráž v zapojení proto hlídá hlavně, aby nová hra nebrala věty těmto žánrům.
- **Čas startu A/A** `baseline-start.json` (A = B = `main`, 6 vět, desktop a pixel7-cpu4, 3 běhy): 0 selhání, ale
  brána T4 padá **jen šumem** – medián desktopu 4 055 ms > 3 000 ms a párový rozdíl telefonu 481 ms > 200 ms.
  Inference: stroj vytížený ~90 % jinými relacemi P68; G4 zapojení na tom padne stejně, dokud se stroj nezklidní,
  nebo se brána nesrovná s tímto šumem A/A (rozhodne T8 při první hře, zapíše se tam).
- **FPS** `baseline-fps.json`: 24 žánrů na `moto-g-power-emulated` (CPU ×4, Fast 4G, GPU hostitele), 3 běhy,
  čtyři dávky po šesti (test má strop 60 min). Medián 59,9 FPS u 18 žánrů, arena 59,5, runner / voyage / quest 30,
  shooter 20; první tik 5,1–12,1 s (emulovaná síť). Věta voyage vydala hru bez záznamu žánru (`published: null`).

## T13 – hybridní pilot (skripty úrovní v QuickJS)

**Co to je.** Za přepínačem `PLAY_SCRIPTS=on` (výchozí vypnuto) napíše model při AI verzi krátký program
`build(api)`, který rozvrhne trať hry `hop` (přeskákání): které řady jsou silnice, řeka nebo koleje a odkud jede
provoz. Program běží jednou, v době tvorby, v sandboxu QuickJS; uloží se jen jeho výsledek (data úrovně, otisk kódu,
verze běhu) a hraje se z něj důvěryhodným runtimem – při hraní se žádný cizí kód nespouští.

- **Cílová hra `hop`:** žádná z `stunt` / `minigolf` / `buildshift` zatím není zapojená (AC).
- **Kde co je:** `src/play/scripts/` – `sandbox.ts` (VM), `api.ts` (`place`, `path`, `rng.int`, `param`),
  `validate.ts` (zakázaná jména, meze, robot), `generate.ts` (písař, opravné kolo, šablona při druhém selhání),
  `lab.ts` (zkušební sada determinismu). Trať z dat: `hopScriptedLayout` v `hop-course.ts` – pruhy počítá táž
  konstrukce jako šablona, takže zaručený přechod pásu platí dál a `checkHopLevel` ho ověří znovu.
- **Závislost:** `quickjs-emscripten-core` 0.32.0 + `@jitl/quickjs-wasmfile-release-sync` 0.32.0 (+ jejich
  `@jitl/quickjs-ffi-types`), přesné verze, MIT podle `LICENSE` balíků (soubor varianty nese i MIT licenci QuickJS,
  Bellard a Gordon); zapsané v `disclosure.json` a `DISCLOSURE.md` v témže commitu.

**Co sandbox drží (testy `sandbox.test.ts` 10, `validate.test.ts` 19, `upgrade-scripts.test.ts` 4):**
- Nekonečná smyčka skončí na rozpočtu vždy na stejném místě: 19 600 losů a 2 000 100 kroků, třikrát za sebou;
  smyčka bez volání API přesně na 2 010 000 krocích.
- `Date` a `Math.random` ve VM nejsou ani pod jménem složeným za běhu; v kódu jsou chybou ověření ještě před VM.
- Paměť 16 MB, zásobník 128 kB; po přetečení jede další běh normálně. Každý běh má vlastní kontext.
- Data mimo mřížku, start, cíl nebo pravidla pásů se odmítnou; uložený spec s daty mimo schéma se nepřečte.
- Přepínač vypnutý (i jakákoli hodnota kromě `on`): písař se nezavolá a AI verze je přesně spec režiséra.

**mutationStatus: pass** – 5 úmyslných chyb, každá zčervenala testy a byla vrácená (`diff -q` proti záloze):
rozpočet podle hodin místo kroků (3 testy), bez mazání `Date` / `Math.random` (2), vypnuté meze dat (7),
vypnutá kontrola přepínače v `_upgrade` (2), vypnutý seznam zakázaných jmen (4).

**Node = Chromium = WebKit:** `e2e/p68-scripts.spec.ts` na `/play/lab/scripts` – 4 programy × 3 semínka (náhoda
hostitele, plovoucí matematika uvnitř QuickJS, dvě zastavení rozpočtem), kanonický JSON 6 652 bajtů. Shodný bajt po
bajtu v projektech `chromium` i `webkit-desktop` (1/1 a 1/1).

**Rychlá hra QuickJS nenese:** po `npm run build` prošel skript všechny chunky z klientských manifestů tras
(`page_client-reference-manifest.js`): `/play` (30 chunků) a `/play/[id]` (32) nemají žádnou značku QuickJS, žádné
`.wasm` a nenačítají ani líně chunky s QuickJS. Kontrola funguje: chunk `/play/lab/scripts` je načítá.

**Měření (jen offline):** měřicí kniha nastavená není (`fast-only`: chybí předpona `-eval` a
`PLAY_EVAL_SPEND_CAP_USD`), takže astra nenapsala nic a nic se neutratilo. Odpovědi napsal **zástupce** – `claude -p`
z předplatného s týmž zadáním (`answers.json`), ne astra. Na 20 dev větách (`hybrid/dev.json`):
- 20 pokusů, 20 platných dat, 20 prošlo robotem (výhra robota i prohra nečinného do 90 s) hned napoprvé,
  0 selhání (selhání by šla do jmenovatele), útrata 0 USD;
- ověření + robot na pokus: p50 91 ms, p95 397 ms (bez modelu, přehrání `answers.json`); zástupce psal p50 17,2 s,
  p95 22,4 s – o astře to nic neříká;
- slepý soudce neběžel: AI verze se skriptem a bez něj bez astry nevznikly. T14 z toho bez placeného běhu
  `eligible` neudělá.

**Odchylky od AC a proč:**
- **Rozpočet 2 000 000 = kroků interpretu, ne volání obsluhy.** QuickJS volá obsluhu jednou za 10 000 kroků;
  2 M volání by nekonečná smyčka pálila ~10 min. Obsluha kroky počítá, volání API přičte 100 kroků (smyčka nad API
  by jinak trvala ~8 s).
- **Zásobník 128 kB:** při 512 kB přetekl dřív nativní zásobník Node a modul se rozbil; 256 kB ještě prošlo.
- **Varianta s `.wasm` vedle sebe, ne vložená:** vložený wasm minifikátor Next přepsal na neplatný kód (build
  spadl v klientu i na serveru). Server ji načítá z `node_modules` (`serverExternalPackages` v `next.config.mjs`).
- **Soubory mimo seznam:** `hop-course.ts` a `hop.ts` (trať z dat), `spec.ts` a `compile.ts` (pole `scriptLevel`,
  hraní z dat), `_publish.ts` (ruční spec `scriptLevel` nenese – jako dřív, kdy ho odmítalo schéma; i remix hry se
  skriptem ručním specem), `spend-cap.ts` (vlastní kniha `PLAY_SCRIPTS_SPEND_CAP_USD`), `level.ts` (čistá část
  ověření pro klientskou laboratoř), `lab.ts` a `ScriptsLab.tsx`, `lab-gate.test.ts`, `next.config.mjs`,
  `.env.example`, `hybrid/pilot.mjs` a `answers.json`.
- **`api.path` hop odmítne:** hop nemá tratě, jen řady; `path` je v API pro budoucí hry.
- **Herní aserce:** výhra robota a prohra nečinného (AC „výhra i prohra“); slabý robot se nežádá – šablona hop to
  taky nesplňuje.
- **Dev věty:** 7 z 20 rychlá hra poslala jinam (aréna, běžec, plošinovka, chodec); přepsané slovesem „crosses“, ať
  pilot měří skript, ne směrování.
- **AI verze se skriptem se publikuje jen na semínku, na kterém ji robot ověřil** (pruhy závisí na semínku).
- simplified: běh je synchronní; skript, který plní paměť drobnými poli, drží server ~12 s, než spadne na
  `out of memory`. Před zapnutím v produkci přesunout do workeru.
- `npm install` nahradil junction `node_modules` (na worktree P64) skutečným adresářem; P64 zůstal beze změny.

## T14 – verdikt hybridu (2. 11.)

**Verdikt T14: `off`** (`hybrid/decision.json`, přepočet z `hybrid/pilot.json` v `__tests__/hybrid-decision.test.ts`).
Splněné: platná data prošla robotem ve 20 z 20 pokusů (100 %, selhání by šla do jmenovatele) a Node, Chromium
i WebKit dávají tytéž úrovně (0 rozdílů, `e2e/p68-scripts.spec.ts`). Nesplněné, protože pilot jel bez měřicí knihy
a písařem byl zástupce `claude -p`, ne astra: slepý soudce „hrál bych“ se skriptem proti bez skriptu neběžel,
p95 prodloužení AI verze a útrata na AI verzi nejsou změřené. Přepínač `PLAY_SCRIPTS` zůstává vypnutý.
Rozhodnuto 2. 11., ne až 5. 11.: T13 je uzavřený a do 5. 11. žádný další běh pilotu není v plánu; když pilot
někdo přeměří placeně, test verdikt přepočítá a `decision.json` musí následovat.

## R7 – čtečka a režisér nabízejí `drawsave` (2. 11.)

- **Nabídka:** `drawsave` pryč z `DIRECTOR_PENDING` a `READER_PENDING`; řádek režiséra = Pitch kategorie
  (`stavba/integration.md`), příklad režiséra z dev d34, tři odpovědi `p68-drawsave-*.json` (věty z tabulky
  kategorie, ne dev) se přeloží, drží hrozbu i počet a projdou publikační branou (`p68-drawsave.test.ts`).
- **Strop promptu čtečky (6 000 znaků):** bez řádku hry zbývalo 15 znaků. Řádek čtečky je proto zkrácený na vlastní
  slova („you draw lines to shield someone from falling things“) a ze šesti starých řádků vypadla jen slova, která
  řádek říká dvakrát („through the air“ vedle „midair“, „from above“ u „fall“, „for a moment“ u „before they hide“,
  „tall“, „identical ones“ → „alike“, „, and“ → „;“). Prompt má 5 998 znaků. Rozhodnutí: krátit opakovaná slova,
  ne ubrat příklad (P66 T13 ubral příklad; tady by každý příklad vrátil chybu, kvůli které v P58B vznikl).
- **Strop růstu promptu režiséra** 2 800 → 3 100 (+288 za řádek žánru a buňku tabulky).
- **Nahrávky P46E znovu** lokálně gpt-oss-20b, 0 USD (`evals/play/p46e/README.md` → P68 R7): `ready` 25/25 beze
  změny, `adds` 0,32 → 0,44. Jediná odpověď s novou hrou je špatně – o03 (závodní auto střílí nepřátele) →
  `drawsave`; `direct()` ji odmítne a AI verze zůstane u závodu.
- **Živá kontrola** (`director-drawsave.json`, `director-live.mjs` nad `shots.mjs serve --director-cap-usd 2`,
  astra jako čtečka i režisér, měřicí kniha `worldsmith:p68-eval`, **1,81 USD**, 9 volání):
  - d38 (rychlá hra trefí): AI verze `drawsave` za 25 s, ale hrdina „explorer“ místo dráčka.
  - d36 (rychlá hra = závod lodí): **čtení hru najde** a hra ze čtení vznikne za 12 s; režisér odpoví kresbou, ale AI
    verze se staví na rychlé hře a musí držet její akce, takže skončí jako roub na závod lodí (95 s, 6 volání).
    Poslední hra hráče je tedy `drawsave` u 1 ze 2 vět. Příčina je sdílená (AI verze kotví na rychlé hře i tam,
    kde čtení našlo jinou hru) → R8.
- R5 (buildshift) a R6 (minigolf) se k nahrávce nepřidaly: obě hry drží registr jako `staged` po nesplněných
  branách T11 a T9, takže by je prompt nevypsal ani bez `DIRECTOR_PENDING` (`readyModes`).

## R9 – čtečka a režisér nabízejí `railfps` (2. 11.)

- **Nabídka:** `railfps` pryč z `DIRECTOR_PENDING`, `READER_PENDING` i `STAGED_CONTROLS` – čtečka smí volit
  i ovládání `railfps` (`drawsave` v R7 ve `STAGED_CONTROLS` zůstal a zůstává). Řádky režiséra (`GENRE_PITCH`)
  a čtečky (`MODE_HINTS`) vlastními slovy podle `prvni-osoba/integration.md` → Popis; pohled z očí v řádku režiséra
  nesou už narážky modulu (`first person`, `on rails`, `rail shooter`). Řádek čtečky stojí za kresbou a před
  bouchnutím, obranou i střílečkou („clowns popping up along the track“ nesmí vzít `whack`). Příklad režiséra
  z dev d20; tři odpovědi `p68-railfps-*.json` (věty kategorie s04, s03, s10, ne dev) se přeloží, drží nepřítele,
  počty z `targets` a `waves` i bosse a projdou publikační branou (`p68-railfps.test.ts`).
- **Strop promptu čtečky (6 000 znaků):** řádek hry a ovládání v seznamu přidaly 82 znaků. Pryč jsou jen slova
  navíc: v řádcích catch („them“), duel („the attack“) a flap („while“) a v pokynech („the control that“ → „the one
  that“, „4 verbs“ → „4“, „the number the sentence gives“ → „the number given“, „in seconds“ u `seconds`, „genre“
  u `sure`, „, one of“ u `world`, „game“ u `title`, úvodní věta přeformulovaná). Prompt má 5 998 znaků.
- **Stropy režiséra:** růst promptu 3 100 → 3 450 (+328 za řádek žánru a buňku tabulky, růst 3 416), kompaktní
  dotaz 14 400 → 14 700 B (14 625 B), 40 zlatých vět 16 900 → 17 200 B (17 096 B).
- **Nahrávky P46E znovu** jednou, lokálně gpt-oss-20b, 0 USD (`evals/play/p46e/README.md` → P68 R9): `ready`
  25 → 23 (o03 a o04 `MALFORMED` – logika s fázemi a časovačem, které nic nezapne), `adds` 0,44 → 0,30,
  `keptRules` / `keptLogic` 100 %. `railfps` nevolila žádná odpověď.
- **Nález cestou (mimo R9):** u věty kategorie s02 („look around and shoot the zombies shambling toward you …“)
  kontrola věrnosti označí „zombie“ jako nástroj (`CAST_IS_TOOL`) a oprava vrátí počet odpovědi na rychlou hru
  (20 → 16). Proto s02 mezi odpověďmi testu není.
- **Živá kontrola** (`director-railfps.json`, `director-live.mjs` nad `shots.mjs serve --cap-usd 0.3
  --director-cap-usd 1.2`, astra jako čtečka i režisér, kniha `worldsmith:p68-eval`, **1,47 USD**, 4 volání):
  - d17 (věta říká pohled i koleje): rychlá hra i čtení `railfps`. Jediné volání režiséra (48 097 vstupních
    tokenů) spálilo všech 8 000 výstupních tokenů na uvažování, odpověď nepřišla → AI verze `MALFORMED`. Hráč má
    hru ze čtení: `railfps`, netopýři ×10, ale terč „mine cart“ a hrdina „first-person ride“ jako v rychlé hře.
  - d22 (ani pohled, ani koleje – „tour jeep … on its own“): rychlá hra, čtení i AI verze `railfps` za 30 s,
    nepřítel „angry monkey“ ×10 a boss téhož druhu; terčem je ale jízda („tour jeep“) a hrdina „monkey“ z rychlé
    hry (`adds: []`).
  - Poslední hra hráče je `railfps` u 2 ze 2 vět, AI verze vznikla u 1 ze 2. Opakování d17 se nedělalo (rozpočet
    R9 1,5 USD).
- R5 (buildshift) se k nahrávce nepřidal: registr ho drží `staged` po nesplněné bráně T11 (`511d0676`).

## R12 – `minigolf` znovu zapojený po opravě P68-L T3 (2. 11.)

- **Rychlá hra** (`9a7d86b2`): vrácené `6e07caf2`, minigolf pryč z `ROUTE_PENDING`, registr `ready`. Brány znovu:
  čas do hratelnosti proti `main` 688d989d (dev d09–d11 × 3 běhy, 0 selhání ze 36) desktop párově −842 ms,
  `pixel7-cpu4` párově −463 ms (T9: +429, mez +200); stráž žánru čistá, herní brána 18/18, `pixel7-touch`
  59,9 FPS, e2e 46/46.
- **Proč je telefon najednou rychlejší** (`79b6121d`): sonda času teď vypíná OpenXR pro obě strany. Na tomhle PC
  hlásí Chromium VR přes SteamVR a hra, která VR umí, startovala cestou VR pomaleji. Část zlepšení je tedy oprava
  měření, ne hry; obě strany se ale měří stejně.
- **Čtečka a režisér** (`eb9aa88b`): minigolf pryč z `DIRECTOR_PENDING` a `READER_PENDING`; řádek čtečky zkrácený
  na „you putt a ball past bumpers into a hole“ kvůli stropu promptu 6 000 znaků. Nahrávky P46E znovu lokálně,
  0 USD; testy 635/0.
- **Živá kontrola** (`director-minigolf.json`, astra jako čtečka i režisér, kniha `worldsmith:p68-eval`,
  **1,27 USD**, 6 volání): d09 i d12 – rychlá hra, čtení i AI verze `minigolf`, AI verze za 67 s a 47 s.
  d12 napoprvé skončil `MODEL_UNAVAILABLE`: strop procesu (1,2 USD) po d09 neměl volných 0,9 USD, které volání
  režiséra rezervuje na nejhorší případ. Opakování na novém serveru se stropem 0,93 USD, aby kniha nepřesáhla 5 USD
  (R7 1,81 + R9 1,47 + R12 1,27 = 4,55 USD).
- Obsah AI verzí (hrdina, překážky) se nekontroloval: hry žijí jen v paměti serveru a skript zapisuje jen žánr.

## T9 – zapojení `minigolf` (nesplněno 1. 11., čas do hratelnosti na telefonu)

- Rychlá hra byla zapnutá (`9edc6781`, `f47cf939`): stráž žánru čistá, herní brána 18/18 na větách, které do
  minigolfu dojdou (dev 7/8 – tučňák d16 jde do arény), FPS `pixel7-touch` 59,9 FPS / p95 16,8 ms, e2e 46/46,
  `p68-roundtrip` bez `skip`. Neprošel jen **čas do hratelnosti na `pixel7-cpu4`**, takže hra **zůstává v
  `ROUTE_PENDING`**, registr nese hotový modul jako `staged` a PR zapojení se neotevřel (vzor T8). Znak `putt`,
  buňka `PRESETS`, svědek a řádek P41 zůstávají pro nový pokus.
- **Čísla** (dev d09–d11 × 3 běhy proti `main` 688d989d, 0 selhání): desktop medián B 2 093 ms, párově −338 ms ✓;
  pixel7-cpu4 párově +429 ms ✗ (mez +200), první snímek párově +60 ms. `main` hraje pro d09 a d10 míčovou hru
  s fyzikou a pro d11 sbírání v aréně: proti d10 je minigolf rychlejší, proti d09 a d11 pomalejší.
- **Kde rozdíl vzniká** (profil hlavního vlákna 6 s od adresy hry, CPU ×4): scéna minigolfu kreslí každý snímek
  už před prvním vstupem (plocha se bez vstupu mění o 20–35 %, u `main` o 1–4 %), takže hlavní vlákno má 0,7 s
  volna proti 1,9 s a sonda se vstupem i snímky plochy čeká déle. Sdílené umístění výzvy „Tap to start“ běží
  s každým snímkem (0,29 s proti 0,15 s), ale je optimalizované od P37B – kolo oprav ve sdílených souborech by ~230 ms
  nevzalo (inference z profilu). Žádost pro kategorii a otázka pro T15 v `integration-log.md`.
- Režisér a čtečka za branou (R6): řádky popisu, příklad a tři odpovědi ve tvaru režiséra jsou připravené
  a `p68-minigolf.test.ts` drží, že se odpovědi přeloží a projdou publikační branou.

## T11 – zapojení `buildshift` (nesplněno 1. 11., čeká na kategorii)

- Rychlá hra byla zapnutá (`819bece3`) a stráž žánru čistá, ale brány hry neprošly, takže hra **zůstává
  v `ROUTE_PENDING`** a PR zapojení se neotevřel. Čísla a žádosti pro kategorii: `integration-log.md`.
- **FPS (tvrdá brána):** `pixel7-touch` medián 59,9 FPS, p95 snímku 49,9 ms (mez 33,8) ve 3 bězích ze 3;
  kontrolní `p66-arrows` prokládaně prošel. Dlouhé snímky hlavně v prvních 4 s stavby.
- **Herní brána:** jedno kolo opravy ve sdílené `gameplay-assert.ts` – `spends` čte i slot těla úrovně (`slots`
  v `assertions.json`; mince obchodu jsou na těle směny), slabý hráč obchodu = obsluha nad `badLayout()`.
  Po opravě fixture ✓, dev 7/8, věty kategorie 17/20, 0 `failed`; zbytek je v souborech kategorie (malý cíl ≤ 8
  nejde prohrát, „for one shift“ čte jako počet zákazníků).
- `p68-roundtrip` buildshift prošel bez `skip`. Čas do hratelnosti a e2e se neměřily – hru zastavila FPS dřív.
- Výklad brány: „brány hry zelené“ = každá brána z AC bez výjimky; herní brána na dev větách se čte jako všechny
  věty (výhra, prohra, akce), ne jako práh G2 ≥ 80 % z T15.

## T8 – zapojení `stunt` (nesplněno 1. 11., čas do hratelnosti)

- Rychlá hra byla zapnutá (`ce35f6fa` až `e1e6e628`): stráž žánru čistá, herní brána na dev větách 19/19, FPS
  `pixel7-touch` 59,9 FPS / p95 16,8 ms, e2e 44 ✓, `p68-roundtrip` bez `skip`. Neprošel jen **čas do hratelnosti**,
  takže hra **zůstává v `ROUTE_PENDING`**, registr nese hotový modul jako `staged` (skladatel ho dál umí přeložit)
  a PR zapojení se neotevřel. Směrování, znak žánru, svědek a meze P41 zůstávají pro nový pokus.
- **Čísla** (3 dev věty × 3 běhy proti `main` 688d989d, kde tytéž věty hrají lehké hry bez fyziky): desktop medián
  B 3 674 ms (mez 3 000), párový rozdíl +1 307 ms (mez +200), pixel7-cpu4 +2 616 ms; 0 selhání.
- **Kde rozdíl vzniká** (HAR a profil procesoru): tvorba na serveru (`POST /api/play/games`) trvá 1,1–1,5 s místo
  0,3–0,4 s. Robot ověřuje tentýž svět třikrát – skladatel (`compose` → `verifyArcade`), kompilace (`compileArcade`:
  robot + přehrání) a publikace (`reportFor` → `verifyArcade`: dvě přehrání a nečinný hráč) – a ~75 % času je krok
  Rapieru. Na klientu přidá stažení Rapieru (2,2 MB) a modely ~0,2 s do prvního snímku a ~0,4 s do hratelnosti.
- **Kolo oprav** (sdílený `arcade/physics/step.ts`): vypnuté vnitřní stopky Rapieru (`profilerEnabled`), které každý
  krok čtou hodiny – v profilu ~4 % času ověření stuntu; simulace beze změny (determinismus a otisky her 142/142).
  Druhá zkoušená úprava – spící tělesa nečíst zpět do stavu – dala v sondě fází spolu se stopkami 1,79 → 1,62 s (−10 %),
  ale změnila otisk hry `merge` (P66/P68 hash), takže je pryč. Chybí ~1,1 s, proto se čas do hratelnosti znovu
  neměřil – výsledek brány by byl tentýž (inference z čísel výš).
- **Co by bránu mohlo zavřít** (inference, pro T15 a kategorii): jedno ověření místo tří (výsledek skladatele sdílený
  s publikací) a stahování Rapieru souběžně s tvorbou. Mez +200 ms proti hře bez fyziky je pro závod s Rapierem
  těsná i potom; T15 rozhodne, jestli platí i pro hry s fyzikou (týká se i `minigolf`, T9).

## T15 – výsledek na holdoutu (3. 11.)

Výsledek je v `result.md`, surová čísla v `result.json`, přepočet v `__tests__/result.test.ts`. Holdout otevřený
jednou 3. 11. v 10:11 UTC (`holdout-opened.json`, otisk sedí). Mez času +200 ms platí podle majitele i pro hry
s fyzikou; `stunt` a `buildshift` ji ani po P68-M nesplnily (R13, R14), zůstávají za branou a jsou nesplněné.

Rozhodnutí a odchylky (výchozí postup, zapsaný, aby šel přeměřit):

- **G1 „v rychlé hře svou hru“** = žánr z `draftGameSpecWithMeta(věta, 1)`, tedy hra, kterou hráč opravdu dostane.
  Obecné věty: `wrongRate` klasifikátoru podle definice T2 na 30 obecných větách holdoutu i na sadě 200, přesuny mezi
  starými žánry na holdoutu i na štítcích T2 (`route-branch.json` proti `route-main.json`). Štítky 105 vět
  holdoutu: `holdout-labels.json` (stejný soudce textu, otázka a 29 typů jako T2, vlastní seed 68015).
- **G2:** věta, kterou rychlá hra pošle do jiné hry, nedostane spec dané hry a počítá se do jmenovatele jako
  selhání. Herní brána překládá spec offline (`arcadeWorldOf`), publikace se nespouští; selhání publikace by
  ukázal G4 (0 selhání ze 108 běhů).
- **G3:** `iphone-touch` jen zapisuje (rozhodnutí T3 – WebKit hostitele, kontrolní `p66-arrows` 23,8 FPS).
- **G4:** u každé zapojené hry první 3 věty holdoutu (podle id), které rychlá hra větve pošle do té hry; výběr podle
  G1, ne podle času. `stunt` a `buildshift` se neměřily – jejich věty do hry nedojdou. Měřicí proces zmizel po 66
  ze 108 běhů bez chyby v logu (tentýž den zmizely bez chyby i procesy focení); chybějící 3. kolo a 2. kolo
  telefonu u `drawsave` doměřily dvě další dávky (`fp-t15b`, `fp-t15c`). Páry se číslují v každé dávce zvlášť.
- **G6:** soudce `claude -p` místo Codexu – 105 listů je víc než denní limit Codexu 50 volání sdílený napříč
  projekty, takže podle pravidla plánu soudí celou sadu `--judge claude`.
- **G7:** měřicí kniha nemá trvalé úložiště (`WORLDSMITH_SPEND_STORE_URL` není nastavené), takže strop procesu byl
  zbytek knihy (7 − 4,55 = 2,45 USD, po restartu 1,73), jako v R12. Od volání režiséra pro `p68-061` odpovídal
  poskytovatel modelu 429 („rate limited or out of credit“) a další volání nic nestála; zbytek vzorku je
  neměřený.
- `director-live.mjs` umí `--set` (jiná sada vět) a `--out` (jiný výstup), aby G7 nepřepsal soubory R7–R12.
