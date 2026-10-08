# P45E T3 – pilot nových zadání na jménech, která v P43 neprošla

**Měřeno:** 8. 10. 2026 20:21–20:58, RTX 3090 pod `gpu-lock.mjs`, build `eb844b80`. Vstup: 15 jmen z karantény P43 (`evals/play/p43/gen3d.md`), třída podle `scripts/p37d/gen-list.mjs` (`bodyOfNoun` + seznam plochých z P45D). Surová data, listy a odpovědi soudce: `D:/caches/p45e/pilot/` (mimo repo).

```
node scripts/p37d/gen-list.mjs --nouns "hippo,wolf,…,statue" --out D:/caches/p45e/pilot/pilot.json
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45e node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from D:/caches/p45e/pilot/pilot.json --precheck --start-comfy --no-quarantine --record D:/caches/p45e/pilot/batch.json
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45e/pilot/batch.json --out D:/caches/p45e/pilot/judge --aliases evals/play/p37d/aliases.json
```

Vlastní mezipaměť (`_gen3d-cache-p45e`): ve výchozí leží modely P43 a dávka by je vrátila bez karty.

## Výsledek

| | P45E | P43 (stejná jména) |
|---|---|---|
| prošlo předkontrolou a bránou kvality | 11/15 | 13/15 bránou (bez předkontroly) |
| slepý soud čtyř pohledů (top1 nebo top3) | **10/15 (67 %)** | 0/15 |

**Brána do T4 (≥ 6/15): prošla.** T4 a T5 generují všechny třídy.

## Po jménech

| Jméno | Třída | P45E | Pokus | P43 |
|---|---|---|---|---|
| hippo | quadruped | top1 „hippopotamus“ | B, semínko 0 (A: potrhaná síť) | brána kvality |
| wolf | quadruped | top1 | A0 | brána kvality |
| orca | swimmer | top1 | A0 | soud: penguin |
| mole | quadruped | předkontrola 3× (pig, sheep, pig) | – | soud: bear |
| firefly | flyer | soud: insect [moth, beetle, fly] | A0 | soud: beetle |
| frisbee | flat | předkontrola 3× (tabletop mirror, mirror, prize wheel) | – | soud: plate |
| receipt | flat | předkontrola 3× (tower heater, checklist, scroll) | – | soud: recycling bin |
| playing card | flat | top1 | A0 | soud: fuel can |
| passport | flat | předkontrola 3× (book, plaque, book) | – | soud: man bust |
| crossbow | prop | top1 | A0 | soud: gun |
| dynamite | prop | top1 „dynamite bundle“ | A0 | soud: spray can |
| jetpack | prop | top1 | A0 | soud: suitcase |
| orange | prop | top1 | A0 | soud: volleyball |
| pie | prop | top1 | A0 | soud: pizza |
| statue | prop | top1 | A0 | soud: man |

Po třídách (soud): prop 6/6, quadruped 2/3, swimmer 1/1, flat 1/4, flyer 0/1; biped a vehicle pilot neměl.

## Co z toho plyne (inference)

- Zlom udělal **rozlišovací znak** v zadání: třída `prop` má stejnou šablonu jako P43 (`prop.a`) a liší se jen znakem – a všech 6 (crossbow, dynamite, jetpack, orange, pie, statue) soudce teď poznal, v P43 žádné. 9 z 10 přijatých prošlo hned prvním zadáním.
- **Ploché věci** zůstávají slabé (1/4): FLUX z „chunky toy version“ kreslí desku nebo knihu, ve které soudce věc nepozná. Předkontrola je zastavila dřív, než karta pálila síť (12 odmítnutých obrázků, ~20 s každý – obrázek a otázka – místo ~70 s celé cesty).
- **Krtek** se znakem „big pink paws“ vyšel jako prase – znak táhne obrázek ke zvířeti, které je mu podobné. Kandidát na nový znak bez barvy.
- Druhé zadání zachránilo 1 jméno (hippo).

## Čas a volání

Medián 77 s na jméno (53–96 s; hippo 293 s se dvěma pokusy). Codex: 24 předkontrol (průměr 12 s, žádná bez odpovědi) + 11 soudů + 1 kouřová zkouška = 36 volání.
