# P30B T1 – mapa ztrát mezi větou a obrazovkou

Naměřeno 2026-09-27 na `fd8cd106` skriptem `scripts/p30b-losses.mjs`. Data: `losses.json`.

## Zdroje

- **draft** – slovní draft (první snímek hry) přes offline řetěz `scripts/play-fidelity.mjs` na HEAD; korpus 30 + zamčená `judge-10`.
- **ai** – zmrazené AI specy z posledních živých běhů (`live.json`: korpus `2026-09-26-p29-ground`, judge-10 `2026-09-25-p28d-t6-j10`) přes týž řetěz na HEAD, plus verdikt poroty nad snímkem. Položka, kterou řetěz kreslí a porota ji nepoznala, je `not-recognized`.
- `evals/play/fidelity/report.json` má jako `latest` běh `2026-09-23-t6` (hrdina 6/18, položky 18/110) – před P28 a P29, proto se bere novější živý běh téhož formátu, ze kterého pochází i výchozí „hrdina 9/18, položky 45/110“.
- Model se nevolá. `ai` specy jsou zmrazené, takže rozdíl proti baseline jde připsat opravám vykreslení a knihovny.

## Baseline

`drawn` = řetěz najde tělo a model z popisku; `poznáno` = porota to na snímku živého běhu viděla (jen `ai`, commit živého běhu, ne HEAD).

| sada | role | draft drawn | ai drawn | ai poznáno |
|---|---|---|---|---|
| corpus | hero | 13/18 | 13/18 | 9/18 (50 %) |
| corpus | item | 19/38 | 24/38 | 16/38 (42 %) |
| corpus | setting | 22/24 | 23/24 | 15/24 (63 %) |
| corpus | verb | 25/30 | 27/30 | 5/30 (17 %) |
| judge10 | hero | 5/5 | 4/5 | 1/5 (20 %) |
| judge10 | item | 7/13 | 7/13 | 3/13 (23 %) |
| judge10 | setting | 3/9 | 7/9 | 2/9 (22 %) |
| judge10 | verb | 4/10 | 5/10 | 0/10 (0 %) |

## 10 největších skupin

Seřazeno podle počtu postižených vět (korpus + judge-10).

| # | zdroj | why | role | ovládání | vět | položky | příčina v kódu | úloha |
|---|---|---|---|---|---|---|---|---|
| 1 | ai | not-recognized | setting | tap_go | 8 | s069:cave, h04:Mars, h06:icy moon, h08:moon, h09:hospital, j03:skyscraper, j04:beach, j07:winter | src/play/compile/look.ts:98-102 – mřížka volí rodinu kulis podle slova prostředí z `SETTING_MATERIAL` (look.ts:22-60); Mars, moon, hospital, winter, icy tam nejsou, rodinu tak vybere seed a hrací pole má paletu rodiny (`terraces` = `dunes`, src/geom/families/01-terraces.ts:19) – porota: „Beige ground … do not clearly identify Mars“. | **T6** |
| 2 | ai | not-in-spec | verb | tap_go | 7 | s069:match, h07:do taxes, h08:date, j01:explain, j02:nap, j03:pitch, j04:walk | src/play/fidelity/chain.ts:158-170 – sloveso je ve specu jen přes ovládání, mechaniku, doplněk nebo pravidlo; režisér zvolil mřížku bez pravidla pro „do taxes“, „date“, „nap“, „pitch“, „walk“. | – Výběr ovládání a pravidel dělá režisér (P30A) a knihovna pravidel; P30B režiséra nemění. T2 hlídá opačnou stranu: sloveso, které ve specu je, se musí opravdu stát. |
| 3 | ai | not-recognized | verb | tap_go | 7 | s002:collect, s003:escape, h01:steal, h04:collect, h06:collect, h09:escape, j07:hoard | scripts/play-fidelity.mjs:459 – porota soudí jeden snímek; „collect“, „escape“, „steal“, „hoard“ na stojícím obraze vidět nejdou. Ztráta měření, ne vykreslení. | **T2** – T2 dokazuje sloveso změnou stavu ve hře místo snímku. |
| 4 | draft | not-in-spec | verb | runner | 6 | s069:match, h07:do taxes, h08:date, j01:explain, j03:pitch, j07:hoard | src/play/draft/controls.ts:311 – slovní draft bez známého žánrového slova padne na běžce; abstraktní slovesa („explain“, „do taxes“, „pitch“) ovládání nenese. | – Slovní draft a čtečka patří P29B/P30A; první snímek s draftem nahradí AI verze (medián 17 s, `2026-09-26-p29-ground`). |
| 5 | ai | not-in-spec | item | tap_go | 5 | h06:alien, j01:quantum physics, j03:investor, j04:ice cream, j07:acorn | src/play/draft/draft.ts:252 + src/play/__fixtures__/collect_exit.json – šablona mřížky nese sbíranou „glowing mushroom“ a režisér ji nechá místo „acorn“ / „ice cream“; „alien“ a „investor“ roli nedostanou vůbec. | – Roli do specu píše režisér (P30A); bez role ve specu nemá vykreslení co kreslit. |
| 6 | ai | not-recognized | item | shooter | 5 | s039:zombie, s037:alien bug, s155:goblin, j05:balloon, j08:skeleton | src/components/play/arcade/ArcadeStage.tsx:117-119 – `FittedModel` vepíše model do kvádru těla nejmenším poměrem os, takže široký nebo plochý model (balónek, kostlivec s křídly) je drobný; nepřátelé střelnice stojí daleko od kamery („Distant figures“, „Tiny green figures“). | **T4** – T4 velikost položek, T5 záběr kamery na nepřátele. |
| 7 | ai | not-recognized | verb | throw | 5 | s050:throw, s088:launch, s095:throw, h03:throw, j06:flip | scripts/play-fidelity.mjs:459 – hod („throw“, „launch“, „flip“) je pohyb, jeden snímek ho neukáže. | **T2** – T2 dokazuje sloveso změnou stavu (poloha projektilu, zmizelý terč). |
| 8 | draft | not-in-spec | item | runner | 4 | j01:quantum physics, j03:investor, j04:dog, j07:acorn | src/play/draft/controls.ts:311 – draft padne na běžce a role `obstacle` / `coin` dostanou popisky ze slovníku (src/play/draft/draft.ts:948), ne „investor“, „dog“, „acorn“. | – Slovník draftu je mimo P30B (čtečka P29B); AI verze z těch čtyř nese jen „dog“ (j04, jako hráče). |
| 9 | draft | not-in-spec | item | throw | 4 | s050:snowball, s095:knife, h03:snowball, h06:crystal, h06:alien | src/play/capabilities.ts:78 – hod čte popisek jen hráče a terče; projektil je vždy míč („ball/item:ball“ i v AI verzi), takže „snowball“ a „knife“ nemají kam jít. | – Chce novou schopnost hodu (projektil z popisku) a spec, který projektil nese (režisér P30A). Kandidát na navazující úlohu, ne T3–T6. |
| 10 | ai | not-recognized | item | tap_go | 3 | h01:fishmonger, h09:flashlight, j01:grandma | src/play/compile/assets.ts:44-60 – mřížka staví sbírané a věci na 0,6 m a kamera obíhá ve vzdálenosti max(12, 1,4 × rozpětí) (src/play/compile/look.ts:110); baterka i rybář jsou na snímku pár pixelů. Živý běh navíc předcházel povýšení gen3d-fishmonger a gen3d-grandma (fd8cd106). | **T4** – T4 velikost a model položek mřížky, T5 kamera. |

## Podle role – vstup pro T3–T6

### hero

- 2 × `ai|no-model|hero|tap_go`: h07:elephant, j07:squirrel
- 2 × `ai|not-recognized|hero|runner`: s006:corgi, j10:elf princess
- 2 × `ai|not-recognized|hero|shooter`: s037:space marine, j09:dragon
- 1 × `ai|no-model|hero|steer`: s056:scooter
- 1 × `ai|not-read-by-control|hero|duel`: s188:grandma
- 1 × `ai|not-read-by-control|hero|move_free`: s111:black hole
- 1 × `ai|not-read-by-control|hero|rhythm`: s144:frog
- 1 × `ai|not-recognized|hero|platform`: s022:robot
- 1 × `ai|not-recognized|hero|steer`: s058:boat
- 1 × `ai|not-recognized|hero|throw`: j06:chef
- 1 × `draft|no-model|hero|steer`: s056:scooter
- 1 × `draft|not-in-spec|hero|throw`: h06:astronaut
- 1 × `draft|not-read-by-control|hero|duel`: s188:grandma
- 1 × `draft|not-read-by-control|hero|move_free`: s111:black hole
- 1 × `draft|not-read-by-control|hero|rhythm`: s144:frog

### item

- 5 × `ai|not-in-spec|item|tap_go`: h06:alien, j01:quantum physics, j03:investor, j04:ice cream, j07:acorn
- 5 × `ai|not-recognized|item|shooter`: s039:zombie, s037:alien bug, s155:goblin, j05:balloon, j08:skeleton
- 4 × `draft|not-in-spec|item|runner`: j01:quantum physics, j03:investor, j04:dog, j07:acorn
- 4 × `draft|not-in-spec|item|throw`: s050:snowball, s095:knife, h03:snowball, h06:crystal, h06:alien
- 3 × `ai|not-recognized|item|tap_go`: h01:fishmonger, h09:flashlight, j01:grandma
- 3 × `draft|not-in-spec|item|tap_go`: h09:flashlight, h10:seal, h10:fish, j06:pancake
- 2 × `ai|not-in-spec|item|platform`: s022:charger, s021:lava
- 2 × `ai|not-in-spec|item|throw`: s050:snowball, h03:snowball
- 2 × `ai|not-recognized|item|runner`: s008:monkey, h10:seal, h10:fish
- 2 × `ai|not-recognized|item|throw`: s088:cardboard box, j06:pancake
- 2 × `draft|not-in-spec|item|platform`: s022:charger, s021:lava, s021:spinning bar
- 2 × `draft|not-in-spec|item|steer`: s056:pizza, s058:crocodile
- 1 × `ai|no-model|item|duel`: h05:kangaroo
- 1 × `ai|no-model|item|runner`: s006:sprinkler
- 1 × `ai|no-model|item|steer`: s056:pizza, s056:traffic
- 1 × `ai|not-in-spec|item|shooter`: j09:knight, j09:arrow
- 1 × `ai|not-read-by-control|item|platform`: s021:spinning bar
- 1 × `ai|not-read-by-control|item|rhythm`: s144:lily pad
- 1 × `ai|not-read-by-control|item|steer`: s058:crocodile
- 1 × `ai|not-read-by-control|item|timing`: s099:pancake, s099:tower
- 1 × `ai|not-recognized|item|duel`: s188:pigeon
- 1 × `draft|no-model|item|duel`: h05:kangaroo
- 1 × `draft|no-model|item|runner`: s006:sprinkler
- 1 × `draft|no-model|item|steer`: s056:traffic
- 1 × `draft|not-in-spec|item|rhythm`: s144:lily pad
- 1 × `draft|not-in-spec|item|shooter`: j09:knight
- 1 × `draft|not-in-spec|item|timing`: s099:pancake
- 1 × `draft|not-read-by-control|item|timing`: s099:tower

### setting

- 8 × `ai|not-recognized|setting|tap_go`: s069:cave, h04:Mars, h06:icy moon, h08:moon, h09:hospital, j03:skyscraper, j04:beach, j07:winter
- 2 × `ai|not-recognized|setting|shooter`: s037:mining colony, j09:village
- 2 × `ai|not-recognized|setting|throw`: s050:snow fort, j06:kitchen
- 2 × `draft|not-in-spec|setting|runner`: j04:beach, j07:winter
- 2 × `draft|not-in-spec|setting|shooter`: j08:tower, j09:village
- 1 × `ai|not-in-spec|setting|tap_go`: j02:café
- 1 × `ai|not-read-by-control|setting|platform`: s022:tower
- 1 × `ai|not-read-by-control|setting|shooter`: j05:birthday party
- 1 × `ai|not-recognized|setting|steer`: s058:jungle river
- 1 × `draft|not-in-spec|setting|platform`: s022:tower
- 1 × `draft|not-in-spec|setting|tap_go`: j02:café
- 1 × `draft|not-in-spec|setting|throw`: h03:castle
- 1 × `draft|not-read-by-control|setting|shooter`: j05:birthday party

## Co z toho plyne

- **Prostředí mřížky** je největší jednotlivá ztráta: 8 vět, u kterých řetěz tvrdí „nakresleno“ a porota vidí béžové nebo neutrální pole → T6.
- **Hrdina a položky** se ztrácejí hlavně tím, že jsou malé nebo daleko (13 hrdinů bez poznání v `ai`; porota píše „tiny“, „small“, „distant“) a u mřížky tím, že `assetSource` nezná množné číslo ani zástupce arkády („purple elephants“, „squirrel“ → `no-model`, src/play/compile/assets.ts:62-65) → T3, T4, T5.
- **Slovesa** na snímku poznat nejdou; jejich důkaz je změna stavu ve hře → T2.
- Ztráty `not-in-spec` (draft i režisér) jsou mimo P30B: patří čtečce a režisérovi.

