# P57 – závěrečný slepý soud scén (T12)

**Cíl nesplněn, T12 zůstává otevřená.** Opus dal scénám po P57 přednost u 8 z 12 vět na desktopu a u 6 z 12 na telefonu, Codex u 8 z 12 v obou pohledech (cíl 9). Dohromady 30 ze 48 hlasů pro „po“. Výměna modelů scénu zlepšila jen málo: Opus u 23 z 24 párů píše, že jsou obě scény „skoro stejné“, Codex rozhoduje podle drobností („slightly more polished“).

## Výsledek proti AC

| Podmínka | Cíl | Naměřeno |
|---|---|---|
| Opus – desktop, P57 vyhraje | aspoň 9/12 | 8/12 |
| Opus – telefon | aspoň 9/12 | 6/12 |
| Codex – desktop | aspoň 9/12 | 8/12 |
| Codex – telefon | aspoň 9/12 | 8/12 |
| Top 50 nejpoužívanějších modelů na 8+ | 50/50 | 16/50 – 34 výjimek níže |
| Top 300 aspoň na 6 | 300/300 | 209/300 – 91 výjimek níže |

## Jak se soudilo

- **Páry:** 12 vět z `audit-12.json` × desktop a telefon = 24 párů. „Před“ = snímky T1 nad `72665fdc` (`D:/caches/p57/baseline`), „po“ = snímky nad `b8930b11`, tj. po T11 se všemi výměnami (`D:/caches/p57/after`). Obojí d3d11, tik 120 (2 s) a 900 (15 s), stejný herní stav.
- **List:** dva panely nad sebou, v každém snímek ve 2 s a v 15 s. Který panel je „před“, losuje `pure-rand` ze jména páru; „před“ bylo nahoře v 11 z 24 párů.
- **Otázka:** která scéna vypadá víc jako hotová hra z obchodu a víc odpovídá větě (`sceneQuestion` ve `scripts/p57/scene-duel.mjs`).
- **Soudci:** Opus 5.5 a Codex, každý vidí jen `sheet.png` v prázdném dočasném adresáři. Opus 22. 10. (24/24), Codex 1 pár 22. 10. a 23 párů 23. 10. po půlnoci (denní strop P57 je 30 volání).
- **Data:** `scene-duel.json` (hlasy a důvody), listy a odpovědi v `D:/caches/p57/scene-duel/`.

## Páry

„po“ = soudce vybral scénu po P57, „před“ = vybral původní.

| Věta | Opus desktop | Opus telefon | Codex desktop | Codex telefon |
|---|---|---|---|---|
| a frog catching flies on a lily pad | po | po | po | před |
| zombies attack my farm at night | po | před | před | před |
| a ninja slicing fruit | po | po | po | po |
| racing a shark through a coral reef | po | před | po | před |
| stack pizzas as high as the moon | před | po | po | po |
| my cat defends the couch from vacuum robots | před | po | před | po |
| a goalkeeper saves penalty kicks in a packed stadium | po | po | před | po |
| match three glowing gems to unlock a treasure chest | po | před | po | po |
| an astronaut dodges asteroids to reach the space station | před | před | po | po |
| a chef flips pancakes for a line of hungry customers | před | po | před | po |
| drum to the beat at a rock concert | po | před | po | po |
| escape a haunted mansion while a ghost chases you | po | před | po | před |

## Prohrané páry a důvod soudce

Číslo panelu v odpovědi je převedené na „před“ / „po“.

**Opus (10):**

- **Zombie, telefon:** skoro shodné, „před“ má o chlup čistší záběr.
- **Žralok, telefon:** skoro shodné, „před“ má trochu lepší kontrast trati a korálů.
- **Pizza, desktop:** „před“ má na kopuli krystalovou ozdobu, „po“ obyčejný šedý podstavec.
- **Kočka, desktop:** prakticky stejné, vysavače nejsou ani v jedné, „volba skoro hodem mincí“.
- **Drahokamy, telefon:** skoro stejné, ani jedna neukazuje zářící drahokamy ani hru „spoj tři“.
- **Astronaut, desktop:** „před“ má na nebi tmavé kameny, které připomínají asteroidy; v obou zmizí astronaut v 15 s za šedou stěnou.
- **Astronaut, telefon:** skoro shodné, žádné asteroidy, astronaut v 15 s za šedou deskou.
- **Kuchař, desktop:** skoro shodné, zákazníci nejsou ani v jedné, palačinka „před“ vypadá propečeněji.
- **Bubeník, telefon:** obě jsou farma místo rockového koncertu; větrné mlýny „před“ jsou podrobnější, „po“ beztvaré.
- **Duch, telefon:** liška, která hráče honí, má „po“ šedomodrou skvrnu, která vypadá jako chyba vykreslení.

**Codex (8):**

- **Žába, telefon:** „před“ má zelené detaily podobné leknínům, které víc sedí k větě; obě scény vypadají jako hra s auty.
- **Zombie, desktop:** „před“ má výraznější stíny a víc detailu prostředí.
- **Zombie, telefon:** „před“ má silnější světlo a zřetelnější postavy.
- **Žralok, telefon:** „před“ má zřetelnější a plnější překážky a detaily útesu.
- **Kočka, desktop:** těsně „před“; obě prakticky stejné, ani jedna neukazuje kočku, gauč a vysavače.
- **Brankář, desktop:** „před“ má podrobnější a pestřejší stromy; stadion ani zákroky brankáře nejsou ani v jedné.
- **Kuchař, desktop:** „před“ má výraznější odlesk pánve a těsnější záběr; zákazníci nejsou ani v jedné.
- **Duch, telefon:** „před“ má čistší obrysy postav a zřetelnější honičku; strašidelný dům není ani v jedné.

## Co z odpovědí plyne

**Fakta:**

- Opus u 23 z 24 párů píše, že jsou scény skoro stejné nebo že vybírá jen jako rozhodnutí remízy. Vybral horní panel v 19 z 24 párů, takže jeho 8/12 a 6/12 víc určuje, kam los dal „po“, než samotné modely.
- Codex horní panel nepreferuje (13 z 24) a „skoro stejné“ napíše jen ve 2 párech; vybírá podle drobností – plnější stromy, stíny, světlo, čistší obrysy.
- Soudci se shodli u 16 z 24 párů: 11× „po“, 5× „před“ (zombie telefon, žralok telefon, kočka desktop, kuchař desktop, duch telefon).
- U 9 z 12 vět aspoň jeden soudce poznamená, že scéna neukazuje, co věta říká: žába je závod aut po silnici (bez žáby, much a leknínu), ninja bez ovoce, kočka bez vysavačů, brankář bez stadionu, drahokamy bez tří stejných drahokamů, astronaut bez asteroidů (Opus; Codex kameny za asteroidy bere), kuchař bez zákazníků, bubeník na farmě místo koncertu, duch bez strašidelného domu.
- Konkrétní zhoršení po výměně podle soudce: objekt na kopuli u pizzy (Opus, desktop), větrné mlýny u bubeníka a liška v honičce u ducha (Opus, telefon; u ducha na telefonu dal „před“ i Codex). Zlepšení: u pizzy na telefonu „zmačkaná rozbitá síť“ nahrazená čistou anténou, u žáby, drahokamů a brankáře pestřejší stromy a květiny.

**Inference:**

- Výměna scénu průměrně trochu zlepšila (Codex 16/24, Opus 14/24), ale modely jsou v záběru malé a scénu určuje hlavně terén, světlo a to, co hra vůbec postaví. Další přegenerování proto číslo 9/12 v obou pohledech spolehlivě nezvedne.
- Levně scény vypadají hlavně proto, že hra neodpovídá větě: chybí hlavní postava nebo předmět věty a místo věty se postaví obecný žánr (závod, běh v pruzích). To je otázka skládání hry (výběr žánru, pravidel a kulis), ne knihovny modelů.

## Doporučení

1. **Další kolo začít shodou scény s větou, ne modely.** Pro 12 vět auditu spočítat, kolik podstatných jmen věty je ve scéně vidět (žába, mouchy, leknín; zákazníci; asteroidy …), a opravit výběr žánru a kulis tam, kde chybí. Patří k pravidlům a žánrům (P56A/C).
2. **Soud scén dělat s oběma pořadími.** Každý pár dvakrát, „před“ jednou nahoře a jednou dole; hlas platí, jen když se obě pořadí shodnou. Bez toho je u téměř shodných scén rozdíl ±3 hlasy šum.
3. **Prohlédnout tři zhoršené kusy:** objekt na kopuli (pizza), větrný mlýn (bubeník), liška (duch). Najít jejich id podle snímků v `D:/caches/p57/after` a případně vrátit starý soubor z `D:/caches/p57/replaced/<id>/`.
   **Hotovo 23. 10.:** `gen3d-windmill` vrácen na původní model (nový byl beztvarý, lopatky jako válce). `gen3d-satellite-radar-dish` (pizza) zůstává – původní byla pomačkaná síť, nová je čistá anténa. Liška u ducha se nevyměnila (`fox` beze změny); rozdíl na snímku je jen jiná fáze animace.
4. **Výjimky knihovny níže nechat, dokud bod 1 neukáže, že na nich scéna stojí.**

## Výjimky knihovny

### Top 50 pod 8 (34 modelů, `top50.json` `summary.below`)

Pořadí = místo v `usage.json` `top300`. Skóre a důvod jsou z posledního soudu (T8, jinak T4).

| # | Model | Skóre | Důvod soudce |
|---|---|---|---|
| 1 | `cc0-bush` | 7 | shrub: Spiky crumpled foliage, dark and noisy; trunk barely visible. |
| 2 | `cc0-grass` | 5 | Thin, sparse blades lack tactile volume and a cohesive toy-like silhouette. |
| 5 | `gen3d-tall-grass-tuft` | 6 | grass tuft: Clean chunky grass clump; slightly busy spiky leaves. |
| 6 | `gen3d-wildflower-patch` | 6 | Dense jagged vegetation and tiny flowers create visual noise at mobile scale. |
| 7 | `cc0-birch-tree` | 7 | Faceted foliage is readable, but the lopsided crown and spindly bent trunk feel awkward. |
| 8 | `cc0-rock-moss` | 7 | mossy rock: Chunky rock with moss cap; plain grey body. |
| 10 | `gen3d-buttercup` | 7 | yellow flower: Bright readable flower; petals lumpy, stem a bit dark. |
| 11 | `gen3d-olive-tree` | 5 | leafy tree: Pale washed-out leaves, noisy clustered canopy. |
| 12 | `gen3d-picnic-table` | 6 | picnic table: Recognisable, but noisy warped wood surfaces look scan-like. |
| 13 | `gen3d-poppy-flower` | 6 | Very thin stem, flat ragged bloom; weak silhouette. |
| 14 | `gen3d-sunflower` | 7 | Bright readable sunflower; spiky petals somewhat noisy. |
| 18 | `gen3d-wooden-stile` | 5 | Odd fence/stile hybrid, ambiguous object; clean chunky wood. |
| 19 | `gen3d-river-boulder` | 6 | mossy boulder: Chunky faceted rock, toy-like; moss patches small and slightly sparse. |
| 20 | `gen3d-rock-pillar` | 7 | Readable stacked stone pillar with tactile chunky forms, but muted colours and uneven detailing. |
| 21 | `gen3d-basalt-column-rock` | 6 | Nearly black shading obscures facets and makes the chunky silhouette visually uninformative. |
| 22 | `gen3d-street-trash-can` | 6 | Jagged overlapping surfaces and apparent tears create a severely fragmented, noisy bin. |
| 24 | `gen3d-sea-rock` | 6 | Rock: Jagged shards and torn faces; crumpled mess, unclear object. |
| 25 | `gen3d-street-tree` | 7 | Bright green chunky canopy and simple trunk create a readable, appealing toy tree. |
| 26 | `gen3d-cardboard-box` | 7 | Chunky box with readable flaps; white smears and awkward top intersections reduce polish. |
| 27 | `gen3d-lighthouse` | 7 | Distinct lighthouse silhouette, but smeared stripes and noisy surface artifacts spoil the toy finish. |
| 30 | `gen3d-concrete-planter-with-tree` | 7 | Crumpled noisy pot surface and shard-like canopy, scan-like. |
| 31 | `gen3d-mossy-boulder` | 4 | Blobby egg shape with noisy torn-looking moss patches. |
| 32 | `gen3d-planter-box` | 5 | Warped melted wood and spiky noisy foliage. |
| 33 | `gen3d-thorn-bush` | 3 | Spiky mine: Clean silhouette but dark, dull colour; ambiguous mine or cactus. |
| 34 | `cc0-car-taxi` | 7 | Taxi car: Chunky, readable toy taxi; slightly soft, smudgy shading and blurry roof sign. |
| 36 | `gen3d-flower-box` | 5 | Lumpy melted planter, noisy flower clutter. |
| 37 | `gen3d-flower-stall` | 7 | Recognisable stall, but jagged foliage and mottled canopy create excessive visual noise. |
| 39 | `gen3d-street-bollard` | 6 | Readable bollard silhouette, but near-black surfaces and uneven cap obscure toy-like form. |
| 40 | `gen3d-street-lamp` | 7 | Clean low-poly lamp silhouette; thin proportions and muted grey reduce chunky toy appeal. |
| 41 | `gen3d-traffic-light` | 6 | Recognisable signal, but crumpled housing and irregular lenses undermine clean toy styling. |
| 46 | `gen3d-sandstone-rock` | 7 | Chunky clean low-poly rock, solid colour; slightly plain blob shape. |
| 47 | `gen3d-scree-rock-pile` | 4 | Noisy jagged shards, dark crumpled shading, scan-like and messy. |
| 49 | `gen3d-bus-stop` | 6 | Readable shelter but wobbly warped edges and uneven base. |
| 50 | `gen3d-finish-banner` | 5 | barrier gate: Thin dark posts, noisy mottled grey beam; not bright or chunky. |

### Top 300 pod 6 (91 modelů)

Skóre aktuálního modelu: vyměněný = soud nového, jinak starý (T8 → T6 → T4). Devět z nich je i v tabulce top 50 výše.

**Starý model zůstal, žádný kandidát nebyl lepší (`kept-old`, 78):** `cc0-grass` 5, `gen3d-olive-tree` 5, `gen3d-wooden-stile` 5, `gen3d-mossy-boulder` 4, `gen3d-planter-box` 5, `gen3d-thorn-bush` 3, `gen3d-flower-box` 5, `gen3d-scree-rock-pile` 4, `gen3d-finish-banner` 5, `gen3d-crater-rock` 2, `gen3d-fuel-silo` 5, `gen3d-meteorite` 4, `gen3d-rock-arch` 3, `gen3d-stone-gatehouse` 4, `gen3d-moon-lander` 3, `gen3d-space-colony-dome` 5, `gen3d-beach-chair` 5, `gen3d-birdhouse` 3, `gen3d-castle-tower` 3, `gen3d-dandelion` 5, `gen3d-dune-grass-clump` 5, `gen3d-picnic-basket` 4, `gen3d-barnacle-rock` 3,5, `gen3d-bread-basket` 3, `gen3d-flour-sack` 4, `gen3d-fruit-crate` 5, `gen3d-wine-barrel` 3, `gen3d-floating-dock` 3, `gen3d-ice-block-pile` 4, `gen3d-ice-igloo` 4, `gen3d-mushroom-cluster` 2, `gen3d-broken-gravestone` 3, `gen3d-cemetery-bench` 4, `gen3d-gift-box` 4, `gen3d-industrial-fan` 3, `gen3d-log-cabin` 3, `gen3d-rooftop-water-tank` 5, `gen3d-tire-pile` 2, `gen3d-toxic-barrel` 4, `gen3d-wild-strawberry-plant` 5, `gen3d-beach-hut` 4, `gen3d-buried-statue-head` 2, `gen3d-desert-shrub` 5, `gen3d-gravestone` 5, `gen3d-jungle-waterfall` 5, `gen3d-mangrove-tree` 4, `gen3d-mesquite-tree` 5, `gen3d-rafflesia` 4, `gen3d-ruin` 2,5, `gen3d-ruined-stone-tower` 3,5, `gen3d-snowy-bench` 3, `gen3d-treehouse` 5, `gen3d-vine-covered-rock-wall` 4, `gen3d-bookshelf` 5, `gen3d-red-barn` 3, `gen3d-television` 2, `cc0-apple` 5, `cc0-clownfish` 4, `gen3d-adobe-house` 4, `gen3d-bear` 3, `gen3d-frog` 4, `gen3d-frozen-waterfall` 3, `gen3d-sea-anemone` 5, `gen3d-sea-sponge` 4, `gen3d-shopping-basket` 2, `cc0-water` 5, `gen3d-brown-owl` 3, `gen3d-magma-crystal` 4, `gen3d-magma-rock` 4, `gen3d-snowy-log-cabin` 4, `gen3d-squirrel` 2, `gen3d-steam-vent` 5, `gen3d-volcanic-rock` 5, `cc0-donut` 5, `cc0-pigeon` 5, `cc0-pipe-bump` 5, `gen3d-apartment-block` 2, `gen3d-baby` 3.

**Nový model nesedl do starého boxu ±10 % (`rejected-bounds`, 13):** `gen3d-stone-water-well` 5, `gen3d-bread-rack` 3,5, `gen3d-fruit-stand` 4, `gen3d-castle-ruin-wall` 3, `gen3d-cholla-cactus` 5, `gen3d-layered-canyon-rock` 5, `gen3d-prickly-pear-cactus` 3,5, `gen3d-wooden-pier` 5, `gen3d-octopus` 4, `gen3d-mine-cart` 4, `cc0-pillow` 4, `cc0-ship-ghost` 5, `cc0-train` 5.

## Majitel (HALT)

Zahrát na vlastním PC a telefonu a zapsat ano/ne: vypadá jako hra z obchodu?

| Věta | PC | Telefon | Poznámka |
|---|---|---|---|
| a frog catching flies on a lily pad | | | |
| racing a shark through a coral reef | | | |
| escape a haunted mansion while a ghost chases you | | | |
