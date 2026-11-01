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
