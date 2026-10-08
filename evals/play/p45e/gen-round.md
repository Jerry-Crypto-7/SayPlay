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

**Dávka 1:**
- Přijatý, nepovýšený: **demon** (top1). S modelem by manifest P32 (`src/play/assets/entries/catalog.json`) získal záznam třídy monster a `src/play/assets/__tests__/catalog-entries.test.ts:29` drží počet 261 → vyřazeno `--drop` jako lizard. Model leží v `D:/claude/_gen3d-cache-p45e/demon/`; povýšit jde, až linie P45D / P44C zvedne počet v testu.
- Soudce poznal něco jiného: coral: fire pit · drill: spark plug.
- Předkontrola odmítla všechny tři obrázky: anthill: rock · blanket: monolith / stone pillar / hedge · canvas: monolith / pillar / pants · captain: military officer / police officer · centaur: horse · comet: plumb bob / ore rock / crystal pendant · dumpling: rock / potato.
- „canvas“ dávka zkrátí na „canva“ – stejná chyba množného čísla jako „cyclop“ (`ops/gen3d/cache.py`, `IRREGULAR`).
