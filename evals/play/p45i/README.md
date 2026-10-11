# P45I – modely přes noc

Plán: P45I (interní). Větev převzala fast-forwardem lokální `features/P45G-modely-prostredi-2026-10-11` (`50796f7d`) – slučuje se **po P45G**, ten po P45F a P45E. Souběžně běží P45H (scenérie podle prostředí v `src/play`); po sloučení P45I jen znovu pustí `scripts/p45h/build-setting-kits.mjs`.

## Odkud jsou jména

1. **8 modelů, které soudce v P45G přijal, ale nepovýšily se** – dog kennel, dog bowl, cow skull, car jack, luggage cart, wizard tower, dinosaur skeleton, rooftop water tank. Manifest P32 jim podle slova ve jménu dal třídu zvířete, vozidla nebo postavy a pin počtu v `src/play` zčervenal. Po opravě manifestu (T2) se povýší z mezipaměti `D:/claude/_gen3d-cache-p45g` bez nového generování.
2. **Dávky 15–16 P45G** (19 jmen) – nespuštěné kvůli oknu, znak v `ops/gen3d/features.toml` mají (`D:/caches/p45g/round15/list.json.held`, `round16/list.json`).
3. **Opakování neprošlých P45G** s novým seedem: 5 s `normalize: LOD1 cannot be made lighter than LOD0`, 5 s `inconsistent face winding`, 13 se správným jménem, ale obrázkem označeným jako rozbitý; 3 se synonymem jen pro předkontrolu (car wreck → wrecked car, dingo → dog, tooth model → tooth) – slepý soud dál soudí původní jméno.
4. **Druhá rekvizita** pro 33 prostředí, která mají po P45G jednu, a **první dvě** pro 11 prostředí bez žádné (`evals/play/p45g/kit-nouns.json`, `evals/play/p45d/missing.json` → `settings`).
5. **Zbylé chybějící předměty** z `evals/play/p45d/missing.json` podle počtu vět, bez šumu (nekreslitelná jména se vyřadí s důvodem níže).

Mimo: `src/play/**` a `src/components/**` (P45H), placená API, zapečetěné sady.

## Okno a strop

- Karta RTX 3090, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Mezipaměť `D:/claude/_gen3d-cache-p45i` (modely P45G z `D:/claude/_gen3d-cache-p45g` se smí číst), záznam dávek `D:/caches/p45i/round<n>/`.
- Po **12. 10. 2026 07:00** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`. Souhrn hotový nejpozději v 07:30.
- Codex na předplatné (předkontrola + slepý soud v prázdném adresáři, jen `sheet.png`): strop celého P45I **900 volání**. Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí. Výstupy soudce nikdy do trénovacích dat.
- Povýšení nesmí změnit výsledek testů v `src/play`; když zčervenají, jméno jde ven přes `promote-batch.mjs --drop` a zapíše se jako zjištění.
- Když P45H zrovna buildí nebo pouští e2e, sady P45I se nespouští (časové testy pod zátěží padají).

## Seznam na noc

`round-nouns.json` – 251 jmen v pořadí, v jakém se generují; `group` u jména říká, odkud je. Žádné nemá katalog (tag ani id), každé má ruční rozlišovací znak v `ops/gen3d/features.toml` pod klíčem po `cache.normalize`.

| Skupina | Jmen | Co |
|---|---|---|
| p45g-rounds-15-16 | 19 | dávky 15–16 P45G (kola 1–2) |
| retry-lod-winding | 10 | P45G: LOD normalizace a `inconsistent face winding` |
| retry-broken | 12 | P45G: předkontrola „rozbitý obrázek“ – znak přepsaný na jeden předmět |
| synonym | 3 | car wreck, dingo, tooth model – předkontrola odmítla blízké slovo, kolo jde bez ní |
| kit-2nd | 31 | druhá rekvizita prostředí, které má jednu |
| kit-none | 18 | první dvě rekvizity 9 prostředí bez žádné; sunken city, tightrope, treasure cave a wedding mají první kusy v kolech 1–2 |
| missing | 12 | chybějící předměty z `missing.json` (karaoke → karaoke machine, iron → clothes iron, brush → hairbrush) |
| retry-p45ef | 32 | neprošlé P45E a P45F |
| kit-3rd | 34 | třetí rekvizita |
| retry-judge | 16 | P45G: slepý soud viděl jiný předmět – znak odkloněný od toho, co viděl |
| kit-4th | 64 | čtvrtá rekvizita a prostředí s málo kusy (narozeniny, útulek, univerzita, cihlová zeď, ostrov pokladů…) |

- **Kola 3–26** v `D:/caches/p45i/round<n>/list.json` po 10 jménech. Semínka `a2,b2,a3` pro všechna: P45E–G použily jen 0 a 1, takže opakování dostane nový obrázek a nová jména o nic nepřijdou. Kolo synonym jde bez předkontroly (precheck.py synonyma nebere), slepý soud dál soudí původní jméno.
- **Třída:** rekvizita prostředí je `prop` (nebo `flat`), ať nese jakékoli slovo třídy („monkey bars“, „duck decoy“, „spring rider“, „dog leash“) – podle téhle ruční třídy ji manifest `src/play` nepovýší na hrdinu. Opakování berou třídu ze svého dřívějšího seznamu, zbytek `entryOf` ze `scripts/p37d/gen-list.mjs`.

### Vyřazená jména

| Jméno | Proč |
|---|---|
| mar, extra work, quarterly budget, story, movie, opera, poem | šum nebo abstraktum – nic k nakreslení |
| rain, ash, pollen, spark, tide, wind, northern light | jev – kreslí scéna nebo efekt, ne model |
| song | zvuk |
| owner, defender, finance team | role nebo skupina lidí bez vlastního vzhledu |
| electricity bill, expense report, sudoku, mortgage paper | papír s textem – od papíru (je v seznamu) ho nic neodliší |
| board, pin, rail | víc významů – soud by nesoudil totéž co hráč |
| crater | tvar terénu |
| vine, tea, fuel | katalog má liánu, šálek čaje, kanystr |
| mane | část zvířete |
| cyclops, canvas, bellows | `cache.normalize` utne koncové s, jméno by se rozešlo s katalogem |
| captain, lizard, wolf, demon | hrdinové – nový model by změnil pin hrdinů v `src/play` (P45H) |
| sandbox | katalog ho pozná přes `seen:sandbox` (vor a mapa pokladu ze slepého soudu P43) |
