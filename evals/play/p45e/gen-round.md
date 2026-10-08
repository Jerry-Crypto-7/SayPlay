# P45E – kolo generování chybějících modelů

## T4 – 48 jmen z výběru P45D (`evals/play/p45d/gen-nouns.json`)

**Měřeno:** 8. 10. 2026 21:04–22:10, RTX 3090 pod `gpu-lock.mjs`, build `87be70ff`, všechny třídy (brána pilota prošla, `gen-pilot.md`). Surová data, listy a odpovědi soudce: `D:/caches/p45e/round/` (mimo repo), mezipaměť `D:/claude/_gen3d-cache-p45e`.

```
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45e node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from evals/play/p45d/gen-nouns.json --precheck --start-comfy --no-quarantine --record D:/caches/p45e/round/batch.json --limit 48
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45e/round/batch.json --out D:/caches/p45e/round/judge --aliases evals/play/p37d/aliases.json --batch-out D:/caches/p45e/round/catalog-batch.json
node scripts/p37d/promote-batch.mjs --batch D:/caches/p45e/round/catalog-batch.json
node scripts/p37d/promote-batch.mjs --drop gen3d-lizard
node scripts/p45d/motion-class.mjs
```

| Krok | Jmen |
|---|---|
| vygenerováno (11 z mezipaměti pilota) | 48 |
| předkontrola obrázku a brána kvality | 33 |
| slepý soud čtyř pohledů (top1 nebo top3) | **20 (42 %)** |
| povýšeno do knihovny | **18 (38 %)** |

**Úspěšnost:** soud 20/48 = 42 % (cíl ≥ 40 %, P43 25 % = 17/69); povýšeno 18/48 = 38 %.

**Povýšeno (18):** top1 hippo, spy, spaghetti, ramp, orca, searchlight, snowmobile, genie, orange, pie, statue, snowboard, playing card, crossbow, dishwasher, jetpack; top3 paper ball („snowball“), portrait („framed portrait“).

**Přijaté soudem, nepovýšené (2):**
- dynamite – `normalize: LOD1 cannot be made lighter than LOD0 at the same size` (stejná třída jako páv P37D).
- lizard – model je hotový a přijatý (`D:/claude/_gen3d-cache-p45e/lizard/`), ale `src/play/arcade/__tests__/hero-choice.test.ts:90,93` staví na tom, že ještěrka model nemá („lizard wolf“ → pes, „wild lizard“ → želva). S modelem věta správně najde ještěrku a test zčervená. Test leží v `src/play/**`, kam P45E nesmí → vyřazeno `--drop`. Povýšit jde po výměně příkladu v testu (linie P45D / P44C).

**Soudce poznal něco jiného (13):** robber: soldier · net: Christmas tree · coffin: medical bag · receipt: stone pillar · mahjong tile: recycling bin · firefly: beetle · fuel: trash can · chimney: bollard · passport: gravestone · stone golem: robot · cape: cloaked statue · golf ball: globe lamp · pinata: horse.

**Předkontrola odmítla všechny tři obrázky (15)** – co v obrázku viděl Codex:
cyclop: man · mole: shrew / bear / wolf · frisbee: tabletop mirror · seashell: gong / shield / diving helmet · towel: mirror / pillar / punching bag · stickman: person · ammo: radiator / pillar / gravestone · bank manager: businessman · financial advisor: businesswoman · mane: wreath / pine cone · poacher: soldier / soldier / hunter · marshmallow: popsicle · broomstick: witch · firework: rocket / rocket / arrow · boomerang: pickaxe / walking cane.

Po třídách (soud): prop 11/19, flat 3/13, biped 2/9, quadruped 2/3, flyer 0/2, swimmer 1/1, vehicle 1/1. Pokus, ze kterého vznikl prošlý model: A0 17×, B0 4×, A1 2×; bránou kvality neprošly 4 pokusy.

Čas: medián 71 s na jméno, 59 min karty. Codex: 76 předkontrol + 33 soudů.

## Zjištění

- **Hrdina nepovýší (P44C linie):** `scripts/assets/p32-manifest.mjs` nezná třídu žádného z nových tvorů – hippo, orca, spy, genie, snowmobile jsou v katalogu (předmět, soupeř přes štítky), ale `src/play/assets/entries/catalog.json` se nezměnil, takže hrdinou nebudou.
- **Role lidí** (bank manager, financial advisor, poacher) slepý soudce nazve obecně (businessman, businesswoman, hunter) – vizuálně správně. Synonyma v soudu (`--aliases`) by je pustila; předkontrola synonyma zatím nebere.
- **„cyclops“** normalizace dávky zkrátí na „cyclop“ (`ops/gen3d/cache.py`, množné číslo) – patří do `IRREGULAR`.
- **Ploché věci** zůstávají nejslabší (flat 3/13): předkontrola je zastaví levně, ale znak v zadání nestačí.
- Slabé přijaté modely pro prohlídku majitelem: portrait (oranžový blok s rámem), dishwasher (pomačkaná bílá krabice).

## T5 – zbytek chybějících jmen podle poptávky

**Vstup:** 39 jmen z `node scripts/p37d/gen-list.mjs --rest` (bin `missing`, mimo `gen-nouns.json` a katalog, bez `scripts/p45d/not-models.txt`), seřazená podle počtu vět – všechna mají 0 vět, takže pořadí je abecední. Dávky po 10 v `D:/caches/p45e/b1..b4/list.json`. Třídu jsme ve vstupu opravili u čtyř jmen, kde ji `bodyOfNoun` určí špatně: captain, demon, singer → biped; chicken leg → prop. Stejná cesta jako T4, jen `--record D:/caches/p45e/b<n>/batch.json --limit 10`.

| Dávka | Jmen | Předkontrola a brána | Soud | Povýšeno |
|---|---|---|---|---|
| 1 (22:06–22:21) | 10 | 3 | 1 | 0 |
| 2 (22:53–23:08) | 10 | 6 | 2 | 2 |
| 3 (23:09–23:30) | 10 | 6 | 3 | 3 |
| 4 (23:30–23:51) | 9 | 5 | 1 | 0 |
| **T5 celkem** | **39** | **20** | **7 (18 %)** | **5 (13 %)** |

**Úspěšnost T5:** soud 7/39 = 18 %, povýšeno 5/39 = 13 % – pod T4 (42 %). Zbytek je z 31/39 předměty (10 plochých), T4 32/48 (13 plochých). Ruční rozlišovací znak v `features.toml` má jen 1 z 39 (wolf – prošel top1), v T4 ho měla jména, která pilot odmítl. Odhad, neměřeno: předmět bez znaku FLUX nakreslí jako obecný kámen či sloup (anthill, dumpling, pebble, tape: „rock“, „gravestone“), takže další kolo začít znaky pro odmítnutá jména, ne dalším semínkem. **Celé P45E (T4 + T5):** soud 27/87 = 31 %, povýšeno 23/87 = 26 % (P43 25 %).

**Nezpracovaná jména: žádná** – seznam došel 8. 10. v 23:51, dlouho před koncem okna (9. 10. 07:30); limit Codexu nedošel (celé P45E ~266 volání: 191 předkontrol + 75 soudů, strop 400); bránu T3 prošly všechny třídy.

**Přijaté soudem, nepovýšené kvůli testům v `src/play` (P45E tam nesmí) – pro linii P45D / P44C:**
- lizard (T4) – `src/play/arcade/__tests__/hero-choice.test.ts:90,93`.
- demon (dávka 1) – `src/play/assets/__tests__/catalog-entries.test.ts:29` (počet 261).
- wolf (dávka 4) – `hero-choice.test.ts:88,90` („grey wolf“ / „lizard wolf“ → pes) a tentýž počet 261.

Modely leží v `D:/claude/_gen3d-cache-p45e/<jméno>/`; povýšení po úpravě testů: `node scripts/p37d/promote-batch.mjs --batch D:/caches/p45e/<b1|b4|round>/catalog-batch.json`.

**Dávka 1:**
- Přijatý, nepovýšený: **demon** (top1). S modelem by manifest P32 (`src/play/assets/entries/catalog.json`) získal záznam třídy monster a `src/play/assets/__tests__/catalog-entries.test.ts:29` drží počet 261 → vyřazeno `--drop` jako lizard. Model leží v `D:/claude/_gen3d-cache-p45e/demon/`; povýšit jde, až linie P45D / P44C zvedne počet v testu.
- Soudce poznal něco jiného: coral: fire pit · drill: spark plug.
- Předkontrola odmítla všechny tři obrázky: anthill: rock · blanket: monolith / stone pillar / hedge · canvas: monolith / pillar / pants · captain: military officer / police officer · centaur: horse · comet: plumb bob / ore rock / crystal pendant · dumpling: rock / potato.
- „canvas“ dávka zkrátí na „canva“ – stejná chyba množného čísla jako „cyclop“ (`ops/gen3d/cache.py`, `IRREGULAR`).

**Dávka 2:**
- Povýšeno (2): top3 fuel can („metal canister“), juice („drink cup“).
- Soudce poznal něco jiného: golem: goblin · chicken leg: torch · keyboard: forge · joystick: chess pawn.
- Předkontrola odmítla všechny tři obrázky: earring: tree / gravestone / sign · glue: square nut / rock / cylinder · magazine: tombstone / block tower / hard drive · flower pot: potted plant (2×, vizuálně správně – synonymum by ho pustilo; třetí pokus neprošel bránou kvality).
- Zjištění pro P45D: `scripts/p45d/motion-class.mjs:155` dá vysoký předmět bez slova třídy do biped (poměr výšky) – fuel can a juice dostaly nohy, stejně jako z T4 searchlight, statue, snowboard a playing card.

**Dávka 3:**
- Povýšeno (3): top1 printer; top3 noodle („churro“, nudle i v pořadí), orb („ball“). noodle dostal z `motion-class.mjs` taky biped.
- Soudce poznal něco jiného: newspaper: signboard · moon rover: dune buggy · notebook: book (vizuálně blízko).
- Předkontrola odmítla všechny tři obrázky: milk: jar / rock · pebble: standing stone / gravestone · pinecone: hop cone / pine tree.
- peacock: třikrát neprošel bránou kvality (`inconsistent face winding`) – stejný páv jako v P37D, TRELLIS na vějíři ocasu.

**Dávka 4:**
- Přijatý, nepovýšený: **wolf** (top1) – viz seznam výše.
- Soudce poznal něco jiného: tablet: computer monitor · space station: mine · tea: mug (vizuálně správně – čaj bez hrnku nejde) · rhino: wild boar, označený jako rozbitý model.
- Předkontrola odmítla všechny tři obrázky: singer: woman / businessman / person (role lidí jako v T4) · swing: squat rack / guillotine / railing · tape: gravestone / pillar · torpedo: drill chuck / grenade (jeden pokus neprošel bránou).
