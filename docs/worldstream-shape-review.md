# Co jazyk tvarů umí a co ne — brána K1

**Rozhodnutí: PROŠLO.** 31. 8. 2026. Rozhoduje se nad `/gallery` a nad čtyřmi
snímky `docs/gallery-0.png` … `gallery-270.png`, které tu stránku zachycují po
90° otáčky. Bránu předepisuje `plans/P13-worldstream.md`, `HALT H1`.

Otázka brány zní: **umí ten jazyk dělat různé věci?** Odpovídá se na dvě půlky
zvlášť — na první stroj, na druhou oko.

## 1. Je dvanáct tvarů viditelně různých? Ano, 12 z 12

Strojová půlka je uzavřená v T7: všech 66 dvojic je nad prahem 0,15, nejbližší
dvojice `cloud`/`fruit` = 0,1663. To ale měří siluety a topologii, ne dojem.
Oko potvrzuje totéž: ze čtyř úhlů není ani jedna dvojice, kterou by šlo zaměnit.

## 2. Vypadá aspoň osm z nich modelovaně, ne jako blob? Ano, 11 z 12

„Blob" je tvar bez hran, bez os a bez zjevného záměru — koule, kterou někdo
promáčkl. Podle toho:

| Tvar | Co na něm člověk vidí | Modelovaný? |
|---|---|---|
| `bone` | ohnutá kost s hlavicí a rozdvojeným koncem | ano |
| `root` | svazek kořenů rostoucí do stran | ano |
| `vault` | **trojzubec na desce, ne klenba** — viz níž | ano, ale mimo jméno |
| `shell` | zkroucená žebrovaná ulita | ano |
| `machine` | stroj: kvádr, válec, příruba, podstavec | ano, nejzřetelněji |
| `column` | kanelovaný sloup s hlavicí a patkou | ano |
| `cloud` | **blob** — a je to záměr, viz níž | ne |
| `staircase` | schodiště se schodnicí, osm stupňů | ano |
| `fruit` | plod se stopkou a rýhami | ano |
| `wave` | přetrhávající se vlna | ano, na hraně |
| `net` | síť s oky a obrubou | ano |
| `cauldron` | kotel s obrubou a třemi nohami — nejlepší kus galerie | ano |

**Blob je jeden a je zaplacený.** `cloud` má `k = 0,55`, tedy největší plynulé
sčítání v galerii, a navrch `displace`. Že je blobovitý, není vada jazyka —
`machine` je ve stejném jazyce napsaný **bez jediného `k`** a nemá jedinou
oblinu. Blobovatost tedy vyrábí jedno číslo v jednom uzlu, ne jazyk. Práh brány
je osm, naměřeno jedenáct, takže se výchozí `k` **nesnižuje**.

## 3. Co jazyk říct neumí

Tohle je druhý výstup brány a je důležitější než verdikt: po vlně 2 bude prompt
modelu svázaný s tvarem jazyka, takže **operace, která chybí teď, se doplňuje
teď, nebo už nikdy levně**.

### Vážné: oblouk se napsat nedá

`vault` je jediný tvar, který **nesplnil své vlastní jméno**. Klenba se
v jazyce skládá z `bend` nad kvádrem, a `bend` ohýbá pole podle jedné
křivosti — z rovného sloupu udělá **hák**, ne půlkruh. Tři takové háky vedle
sebe čtou jako trojzubec. Chybí jedna ze dvou operací:

- **`revolve`** — profil otočený kolem osy o zadaný úhel. Klenba, kupole, oblouk
  mostu, tunel, oblina nádoby.
- **`sweep` po oblouku** — profil tažený po kružnicovém segmentu.

Dopad je větší než jeden tvar galerie: **architektura stojí na obloucích.**
Věta „a cathedral", „a bridge", „an aqueduct", „a tunnel" dnes nemá čím
vzniknout. Doporučení: doplnit `revolve` ve vlně 1, před tím, než se ve vlně 2
píše prompt.

### Užitečné, ale ne blokující

- **`shell` / `hollow`** — dutá stěna dané tloušťky. Dnes se dutina dělá
  odečtem zmenšené kopie a řezem rovinou (`cauldron`, čtyři uzly z jedenácti).
  U trupu lodi, zvonu, misky nebo trubky je to pokaždé znovu ta samá práce.
- **`elongate`** — protažení primitivu mezi jeho konci bez roztažení oblin.
  Dnes se stadionový tvar dělá kapslí, a kapsle má jen jednu osu.
- **`round` / `fillet` nad hranou** — dnes existuje jen `roundBox` a plynulé
  `k` u sjednocení. Zaoblit hranu jednoho kvádru nejde.
- **`arrayAlongCurve` neotáčí kopie do směru křivky.** Naměřeno v T7: kořen se
  rozpadl na oddělené pilulky a spravovalo se to velikostí kusu. Je to past pro
  model, který ten uzel použije poprvé.

### Vědomě neřešené

- **Barva a materiál.** V galerii je jediná hlína schválně — rozmanitost se má
  soudit z geometrie, jinak by stačilo obarvit dvanáctkrát kouli.
- **Rozlišení 48³.** Na tenkých kusech (`net`, `wave`, žebra `shell`) je vidět
  schodovitost mřížky. Je to volba měřidla, ne strop jazyka; žebřík detailu
  z vlny 3 tytéž programy vymešuje jemněji.

## 4. Co se u brány našlo a opravilo

**Popisky neseděly pod svými tvary a žádný test to nemohl poznat.** HTML mřížka
stála na čtyřech dílech šířky okna (320 px při 1280), kdežto kusy stojí
3,4 světové jednotky od sebe, což při kameře na `z = 16` a zorném úhlu 42° dělá
199 px. Kost tak vyšla blíž k popisku `Root` než ke svému vlastnímu.

Testy to nechytily, protože obě dosavadní aserce porovnávají **index buňky**
s indexem v `GALLERY_IDS` — a ten seděl. Vada byla výhradně v pixelech.

**Naměřeno 31. 8. 2026** na starém rozvržení při 1280×720, jako vzdálenost mezi
středem popisku a těžištěm hlíny, která k němu má nejblíž:

| Sloupec | Tvary | Posun |
|---|---|---:|
| 1 | `bone`, `machine`, `cauldron` | **139,8–150,7 px** |
| 2 | `root`, `column`, `fruit` | 16,7–52,7 px |
| 3 | `vault`, `cloud`, `wave` | 10,0–35,6 px |
| 4 | `shell`, `staircase`, `net` | **131,8–150,9 px** |

Buňka je široká 199 px, takže krajní sloupce se posunuly o **tři čtvrtiny
buňky**. U `bone` a `staircase` zbylo v jejich vlastní buňce jen 461 a 564
pixelů hlíny — zbytek tvaru už patřil sousedovi.

Opraveno tím, že se obdélník mřížky **promítá skutečnou kamerou**, do které se
kreslí, a popisky sedí na něm. Nová aserce v `e2e/gallery.spec.ts` přiděluje
každý dost světlý pixel plátna nejbližšímu popisku a soudí těžiště po sloupcích;
je to Voronoi nad dvanácti body, takže nezná ani rozteč buněk, ani kameru — ptá
se přesně na to, co člověk v bráně.
