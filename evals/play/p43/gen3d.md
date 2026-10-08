# P43 T12 – modely vygenerované pro chybějící podstatná jména

Seznam: `gen3d-nouns.txt` (69 jmen z `missing.json`). Řetěz: `ops/gen3d` (FLUX.2-klein-4B → TRELLIS.2-4B, semínko 0) → brána kvality → slepý soud Codexu nad listem čtyř pohledů (`scripts/p37d/judge-sheet.mjs`, 56 volání) → `scripts/p37d/promote-batch.mjs`.

| Krok | Prošlo |
|---|---|
| vygenerováno | 69 |
| brána kvality | 56 |
| slepý soud (top1 nebo top3) | 17 |

## Povýšeno do knihovny (17)

top1: scarf, rope, fire truck, sign, sleigh, boxer, icicle, pyramid, caveman, suitcase, jack o lantern, microwave.
top3: sweater (sweatshirt), mailman (delivery man), stick (rod), spellbook (book), mask (human head).

## Zůstává v karanténě (`asset-quarantine/gen3d-*`)

**Neprošlo bránou kvality (13):** hippo, lizard, cyclop, searchlight, snowmobile, stone golem, wolf, rhino, peacock, centaur, pinecone, torpedo, moon rover.

**Soudce poznal něco jiného (37)** – jméno: co viděl:
paper ball: egg · spy: soldier · frisbee: plate · seashell: spinning top · coffin: cooking pot · towel: payphone · net: rolling pin · receipt: recycling bin · mahjong tile: speaker · ramp: door · puddle: plate · ammo: beverage can · firefly: beetle · chimney: bollard · orca: penguin · passport: man bust · mole: bear · portrait: bust · poacher: soldier · crater: bowl · genie: elf · orange: volleyball · marshmallow: cotton candy · pie: pizza · cape: vase · statue: man · snowboard: skateboard · golf ball: tree · broomstick: broom · playing card: fuel can · pinata: bush · firework: feather duster · dynamite: spray can · boomerang: hoe · crossbow: gun · dishwasher: storage bin · jetpack: suitcase.

**Rozbité (2):** robber (soldier), spaghetti (scrap metal).

## Zjištění

- Úspěšnost generátoru u chybějících jmen je 17/69 (25 %). Vychází hlavně věci s jasným tvarem (vozidla, nábytek, postavy s výrazným oblečením). Plochá a drobná jména (receipt, playing card, puddle, passport) a zvířata s podobnými sourozenci v knihovně (mole → bear, orca → penguin) neprošla.
- Hydra (soupeř ve větě f22) v knihovně chybí a v `gen3d-nouns.txt` není.
- Pět modelů z mezipaměti nemělo semínko a povýšení je odmítlo. Opraveno v `ops/gen3d/batch.py` (mezipaměť semínko ukládá), u těch pěti je doplněné semínko 0, se kterým běžela celá dávka.
