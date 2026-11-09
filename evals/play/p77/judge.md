# P77 T6 – brána slepým soudcem

**Výsledek: brána nesplněná ani po jednom kole ladění.** Proti konceptu 0/12 (brána > 0), proti dnešní produkci 6/12 a 7/12 podle pořadí stran (brána ≥ 10/12). Soudce proti produkci ale z 24 listů zvolil pravou stranu 21× – jedno pořadí stran proto měří hlavně stranu listu, ne scénu. Podle AC zapsáno a běh pokračuje.

## Brány

| Soudce | Brána | Kolo 1 (`bb449a96`) | Kolo 2 (`78a73667`) |
|---|---|---|---|
| proti konceptu (`p75-judge.mjs`, s HUD) | > 0/12, cíl ≥ 3/12 | 0/12 (`p77-after`) | 0/12 (`p77-tuned`) |
| proti produkci, losování semínkem 7309 (`p77-vs-main.mjs`) | ≥ 10/12 | 7/12 | 6/12 |
| proti produkci, prohozené strany (`--flip`) | – | – | 7/12 |
| obě pořadí dohromady | – | – | 13/24 |

„Před“ jsou snímky `evals/play/p77/base/` (`main` v odbočení P77, `cecccbe1`), „po“ `evals/play/p77/after/` (kolo 2 je přefotilo, kolo 1 je v historii u `a89a3509`). Tabulky s důvody: kolo 1 `vs-main-r1.md`, kolo 2 `vs-main.md` a `vs-main-flip.md`, proti konceptu `evals/play/p75/judge.md` (sekce `p77-after`, `p77-tuned`).

## Zaujatost stranou

| Běh | Pravá strana zvolena | „Po“ vyhrálo vpravo | „Po“ vyhrálo vlevo |
|---|---|---|---|
| kolo 1 | 11/12 | 6/6 | 1/6 |
| kolo 2, semínko 7309 | 10/12 | 5/6 | 1/6 |
| kolo 2, prohozené | 11/12 | 6/6 | 1/6 |

Skoro každý důvod, kde vyhrála produkce, začíná „The right scene…“. Kolo 2 proto soudilo každý list v obou pořadích; nezávisle na straně rozhodly jen 3 věty z 12:

- **P77 vyhrálo v obou pořadích:** stohování palačinek (s4 – „more cohesive warm lighting and weathered materials“, produkci vytýká „stark black and cyan fountain“) a tučňák na ledové hoře (s12 – velké ledové útvary dávají hloubku popředí–pozadí).
- **Produkce vyhrála v obou pořadích:** závod pod vodou (s2 – „dark, tangled clusters“ korálů u P77 proti „cleaner coral silhouettes“).
- **Zbylých 9 vět** rozhodla strana listu.

**Inference:** tímhle soudcem rozdíl P77 proti produkci změřit nejde – na 9 z 12 vět je pod šumem strany. Z toho, co změřit jde, je P77 2 : 1.

## Kolo ladění (`78a73667`)

Podle důvodů soudce z kola 1, kde vyhrála produkce:

| Důvod soudce (kolo 1) | Změna | Kolo 2 |
|---|---|---|
| s8, s10 „stronger contact shadows / more defined shadows“ | stín slunce poloměr PCF 4 → 2, síla 0,82 → 0,95; elipsa pod předměty krytí 0,5 → 0,65 | s8 a s10 rozhodla strana (vyhrálo pravé v obou pořadích) |
| s3, s4 „stronger contrast, dark stone and turquoise accents“ | kulisa drží 35 % vlastní barvy (Oklab a, b), dřív čistý tón palety | s4 vyhrálo P77 v obou pořadích; s3 rozhodla strana |
| s9 „oversized gold structures feel cluttered“ | rámující řada u trati jen z modelů do 6 m (mrakodrapy ve městě ne) | s9 rozhodla strana; výtka k velikosti zmizela |

Proti konceptu se nepohnulo nic: soudce dál vybírá koncept („more polished lighting, cohesive geometry“, hra „cluttered and prototype-like, with rougher scenery and UI“). Část rozdílu dělá rozhraní (T1: bez HUD také 0/12, tedy ne jen HUD).

## Výkon telefonu po ladění

Stín a krytí elipsy platí pro všechny hry; řada po trati na telefonu není (T5), přebarvení běží jednou při načtení. Změřeny dvě hry nejblíž mezi 40 FPS (Pixel 7, CPU 4×, A = `main` 3207, B = větev 3208, prokládaně): `perf-fps-t6.json`.

| Hra | A `main` | B větev | Mez | Soubor |
|---|---|---|---|---|
| běh na sopce (s1), 4 páry | 43,6 | 42,8 | ≥ 40 drží | `perf-fps-t6.json` |
| závod pod vodou (s2), 4 páry | 44,2 | 40,0 | ≥ 40 drží těsně | `perf-fps-t6.json` |
| závod pod vodou (s2), 6 párů | 42,4 | 40,2 | ≥ 40 drží těsně | `perf-fps-t6b.json` |

Mez (medián ≥ 40) drží v obou hrách. Skript píše „FAIL“ kvůli p95 33,4 ms proti limitu 33,3 – to má stejně i `main` (snímek po 30 Hz).

**Inference:** odstup závodu od `main` (−2 až −4 FPS, v T5 po opravě +0,9) změny kola 2 nejspíš nedělají – mění jen konstanty (síla a poloměr stínu, krytí elipsy, barvy počítané jednou při načtení), žádné kreslicí volání ani průchod navíc (volání 66 → 73 jako po T5). Stroj byl vytížený jinými relacemi (CPU 36–47 %), jednotlivé běhy B 35,7–42,8. Ověřené to není: změřit znovu po sloučení spolu se známým selháním prvního snímku u závodu (`perf.md`).

## Co z toho plyne

- Měřitelně se kolo 2 od kola 1 neliší (7/12 → 6/12 a 7/12, v šumu strany), ale výtky, na které ladění mířilo (stíny, kontrast, přerostlé budovy), z důvodů soudce zmizely – změny zůstávají.
- **Inference:** další ladění proti tomuhle soudci nemá smysl, dokud soudí jedno pořadí stran; každé další měření pustit v obou pořadích (`--flip`) a počítat jen věty, které vyhrají oba listy.
- Závod pod vodou (s2) je jediná věta, kde produkce vyhrává bez ohledu na stranu – tmavé shluky korálů po přebarvení. Kandidát na další práci, ne do řezu 10. 11.
