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

## Souhrn kola (11.–12. 10. 2026, 21:49–07:03)

| | Jmen | Předkontrola a brána | Slepý soud | Povýšeno |
|---|---|---|---|---|
| P45I, kola 1–26 (první pokus) | 251 | 207 | **147 (59 %)** | **141 (56 %)** |
| P45I, kola 27–35 (opakování) | 78 | 52 | 14 | 9 (12 %) |
| P45G, 14 dávek | 140 | 110 | 87 (62 %) | 74 (53 %) |

- **Cíl ≥ 60 modelů splněn: 160 nových modelů v katalogu** (1041 → 1201), každý s licencí a původem v `disclosure.json`:
  - 150 z kol P45I,
  - 8 přijatých v P45G, které pustila až oprava třídy v T2,
  - 2 z P45F (anthill, chicken leg).
  - Po kolech a jménech: `gen-round.md`.
- **Úspěšnost proti P45G:** první pokus 59 % soud / 56 % povýšení proti 62 % / 53 %, tedy srovnatelná. *Odhad, neměřeno:* povýšení je vyšší, protože po T2 už žádný přijatý model nezastaví slovo ve jménu.
- **Opakování skoro nic nepřinesla:** 9 povýšených ze 78 pokusů. Kola 27–29 navíc soudila tentýž model z mezipaměti (22 jmen) – `batch.py` vezme mezipaměť dřív, než zkusí nová semínka; od kola 30 odsunuto ručně.
- **Cíl ≥ 2 rekvizity na zpracované prostředí splněn u 68 ze 78** (P45G: 20 ze 64). Počítané jen nové modely P45G a P45I, stejně jako v P45G.
  - Jednu rekvizitu má 6: rocky river, junkyard garage, tightrope, zoo, birthday party, treasure island.
  - Žádnou nemají 4: snow fort (snowball bucket, toboggan – soudce viděl koš a kufr), treasure cave (gold pile, stalagmite, golden idol), brick wall (brick pile), mushroom hill (mushroom ring).
- **Co zbylo (101 z 251 jmen)**, podle posledního pokusu:
  - 51 – soudce poznal jiný předmět (stalagmite → dopravní kužel, hubcap → kolo, tablet → monitor).
  - 36 – předkontrola odmítla všechny obrázky. U 13 z nich viděla správné jméno, ale obrázek označila jako rozbitý (víc kusů nebo useknutý předmět – tire stack, ore pile, laundry basket).
  - 7 – soudce přijal, povýšení selhalo na `normalize: LOD1 cannot be made lighter than LOD0`: wedding arch, sea urchin, wildflower, snowy pine tree, gargoyle, city hall, stagecoach. Stagecoach selhal stejně i na novém modelu, takže jde o chybu normalizace, ne o smůlu generování.
  - 7 – brána kvality, `inconsistent face winding` (rozbitá síť).
  - Kolo 36 (9 opakování) nezačalo kvůli oknu.
- **Codex:** 756 z 900 volání (497 předkontrol + 259 soudů), limit nedošel.
- **Velikost:** 160 modelů = 320 GLB (LOD0 a LOD1) **19,9 MB** + 160 náhledů PNG 4,1 MB. Modely P45E–I leží v `public/assets/worldstream/gen3d-p37d/` – celkem **67 MB**. `public/assets/worldstream/gen3d/` (63 MB) P45I nemění.

## Sady (T5, 12. 10. 2026 07:05–07:09)

- Po každém kole prošly `src/assets`, `scripts/p37d`, `scripts/assets`, `models-qa`, `hero-choice` a `catalog-entries`. Výjimky – zapsané v těle commitu kola:
  - kolo 12: HOLD kvůli pinu `missing-nouns`, opraveno (`5506831f`);
  - kola 1 a 8: časové testy pod zátěží karty, samy zelené.
- `evals/play/catalog-coverage.json` přegenerovaný (1041 → 1201 modelů). `node scripts/assets/cc0/coverage.mjs` ve worktree bez vlastního `node_modules` spadne (hledá `node_modules/vitest` jen ve worktree), proto běžel stejný příkaz přes `npx vitest run --config vitest.measure.mts evals/play/catalog-coverage.measure.ts`.
- `npx vitest run src/assets scripts src/play/arcade/__tests__` + test pokrytí, v klidu (karta 0 %, žádný jiný běh): 143 souborů, **3316 z 3317 testů prošlo**. Jediný červený je `scripts/__tests__/submission-check.test.ts` – čte gitignorovaný `plans/P8-odevzdani.md`, který worktree nemá; stejně jako v P45G, s P45I nesouvisí.
- Kontrola ve hře není součást P45I – dělá ji P45H po sloučení.

## Doporučení

1. **Oprava `normalize: LOD1 cannot be made lighter than LOD0`** vrátí 7 přijatých modelů bez nového generování – všechny leží v `D:/claude/_gen3d-cache-p45i/` (starší model stagecoach v `_superseded/stagecoach-r34`).
2. **Opakování ne, nová jména ano:** první pokus dává 56 %, opakování 12 %. Pokud se opakuje, `batch.py` potřebuje volbu, která při `--attempts` přeskočí mezipaměť – jinak se soudí starý model.
3. **10 prostředí bez dvou rekvizit** potřebuje jiná jména, ne další semínka: jmenované předměty soudce nepoznal ani na druhý pokus.
4. **Předkontrola s pravopisnými variantami** (pinecone / pine cone, snow plow / snowplow) by pustila k soudu aspoň 2 jména.
5. **Slepý soudce není úplně stálý:** ze 22 stejných modelů posouzených podruhé jeden změnil výsledek (ballot box z „no“ na top3). U hraničních jmen by pomohly dva soudy a přijetí jen při shodě.

## Slučování

Slučuje se **po P45G** (větev P45I na ní stojí). Konflikt v `src/assets/catalog-motion.json` a `evals/play/catalog-coverage.json` se neřeší ručně: vzít libovolnou stranu a znovu spustit `node scripts/p45d/motion-class.mjs` a měření pokrytí. Po sloučení P45H znovu pustí `scripts/p45h/build-setting-kits.mjs`. `src/play` a `src/components` P45I nemění.
