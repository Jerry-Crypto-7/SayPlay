# P45F – druhé kolo pro jména, která v P45E neprošla

**Vstup:** 58 jmen z `evals/play/p45f/retry-nouns.json` s novým ručním znakem v `ops/gen3d/features.toml`, dávky po 10 v pořadí seznamu (`D:/caches/p45f/round<n>/list.json`). Stejná cesta jako `evals/play/p45e/gen-round.md`, RTX 3090 pod `gpu-lock.mjs`, nová mezipaměť `D:/claude/_gen3d-cache-p45f` (žádný pokus z P45E se nepřebírá). Surová data, listy a odpovědi soudce: `D:/caches/p45f/round<n>/` (mimo repo).

```
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45f node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from D:/caches/p45f/round<n>/list.json --precheck --start-comfy --no-quarantine --record D:/caches/p45f/round<n>/batch.json --sheet D:/caches/p45f/round<n>/batch-sheet.png --limit 10
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45f/round<n>/batch.json --out D:/caches/p45f/round<n>/judge --aliases evals/play/p37d/aliases.json --batch-out D:/caches/p45f/round<n>/catalog-batch.json
node scripts/p37d/promote-batch.mjs --batch D:/caches/p45f/round<n>/catalog-batch.json
node scripts/p45d/motion-class.mjs
```

Modely a náhledy povýšení zapisuje do `public/assets/worldstream/gen3d-p37d/` (cesta `promote-batch.mjs`, stejně jako P45E).

Listy pro soud renderuje `scripts/assets/qa-sheets.mjs` s three.js z `node_modules` worktree – bez junction na `node_modules` hlavního checkoutu (stejný `package-lock.json`) skončí všech 8 listů na `waitForFunction: Timeout` a soud nemá co hodnotit. Junction je založená před prvním soudem, jako v P45E.

| Dávka | Jmen | Předkontrola a brána | Soud | Povýšeno | Codex (předkontrola + soud) |
|---|---|---|---|---|---|
| 1 (07:43–08:08) | 10 | 8 | 4 | 4 | 17 + 8 |
| 2 (08:02–08:22) | 10 | 7 | 4 | 3 | 19 + 7 |
| 3 (08:19–08:43) | 10 | 8 | 4 | 2 | 19 + 8 |
| 4 (08:36–09:03) | 10 | 7 | 5 | 5 | 17 + 7 |
| 5 (08:59–09:17) | 10 | 7 | 1 | 1 | 16 + 7 |
| **Celkem** | **50** | **37** | **18 (36 %)** | **15 (30 %)** | **88 + 37 = 125** |

**Úspěšnost P45F:** soud 18/50 = 36 %, povýšeno 15/50 = 30 % – nad celým P45E (soud 31 %) a nad stejnými jmény v P45E (soud 0/50, předkontrola a brána 21/50 proti 37/50 teď). Přijaté soudem a nepovýšené kvůli testům v `src/play` (3): anthill, captain, chicken leg.

**Povýšeno (15):** coffin, bank manager, chimney, firefly (1); stone golem, net, stickman (2); cape, coral (3); flower pot, glue, joystick, earring, firework (4); milk (5).

**Nezpracovaná jména (8) – okno:** rhino, singer, space station, swing, tablet, tape, tea, torpedo (dávka 6, `D:/caches/p45f/round6/list.json`). Dávka 5 skončila generovat v 09:14; dávka 6 by s generováním (~17 min), soudem a sadami T4 nestihla 09:40, proto se nespustila. Znak v `features.toml` mají připravený. Limit Codexu nedošel (125 ze 150).

**Dávka 1** (robber … mahjong tile; v P45E 0/10 prošlo soudem, 5/10 předkontrolou a branou):
- Povýšeno (4): top1 coffin; top3 bank manager („banker“), chimney („factory“, komín ve výčtu), firefly („fly“, světluška ve výčtu).
- Soudce poznal něco jiného: ammo: trash can · financial advisor: businesswoman (role lidí jako v P45E) · mahjong tile: pedestal · robber: person, označený jako rozbitý model.
- Předkontrola odmítla všechny tři obrázky: frisbee: ashtray / ashtray / plate · cyclops: **cyclops** třikrát – obrázek je správně, ale dávka jméno normalizuje na „cyclop“ (`ops/gen3d/cache.py`, množné číslo) a předkontrola porovnává s ním. Znak teď do zadání dojde (klíč `cyclop`), shodu zablokuje až porovnání; oprava patří do `IRREGULAR` v `cache.py` (kód generátoru, mimo P45F).

**Dávka 2** (mole … anthill; v P45E 0/10 soudem, 4/10 předkontrolou a branou):
- Povýšeno (3): top1 stone golem („rock golem“); top3 net („standing mirror“, butterfly net a fishing net ve výčtu), stickman („stick figure“).
- Přijatý, nepovýšený: **anthill** (top1). `scripts/assets/p32-manifest.mjs` mu podle slova „ant“ dal třídu animal a záznam v `src/play/assets/entries/catalog.json`, takže `src/play/assets/__tests__/catalog-entries.test.ts` (pin počtu) zčervenal → vyřazeno `--drop gen3d-anthill`. Model leží v `D:/claude/_gen3d-cache-p45f/anthill/`; povýšit jde po opravě třídy v manifestu (mraveniště není zvíře) nebo po zvednutí pinu.
- Soudce poznal něco jiného: poacher: thief (bandit, burglar – role lidí) · receipt: CD rack · seashell: ice cream sundae.
- Předkontrola odmítla všechny tři obrázky: mole: pig / pig (jako pilot P45E s růžovými tlapkami; třetí pokus neprošel branou) · passport: book ×3 (vizuálně blízko) · towel: stack of towels / towel stack (oba označené jako rozbité) / armchair.

**Dávka 3** (blanket … coral; v P45E 0/10 soudem, 3/10 předkontrolou a branou):
- Povýšeno (2): top1 cape, coral.
- Přijaté, nepovýšené (2): **captain** (top1 „ship captain“) – manifest P32 mu dal třídu humanoid; **chicken leg** (top1 „meat drumstick“) – třídu bird podle slova „chicken“. Oba zapsaly záznam do `src/play/assets/entries/catalog.json` a pin počtu v `catalog-entries.test.ts` zčervenal → `--drop`. Modely v `D:/claude/_gen3d-cache-p45f/`.
- Soudce poznal něco jiného: blanket: gift box · boomerang: climbing wall · centaur: warrior (koňské tělo soudce nezmínil) · comet: popsicle.
- Předkontrola odmítla všechny tři obrázky: broomstick: double-ended broom / broom / broom (vizuálně správně – koště; synonymum by ho pustilo) · canvas: easel ×3 (stojan přebil plátno, jméno navíc dávka zkrátí na „canva“).

**Dávka 4** (drill … keyboard; v P45E 0/10 soudem, 5/10 předkontrolou a branou):
- Povýšeno (5): top1 flower pot, glue („glue bottle“), joystick; top3 earring („seal stamp“, náušnice ve výčtu), firework („firecracker“).
- Soudce poznal něco jiného: drill: screwdriver (akušroubovák – vizuálně blízko) · keyboard: shoe rack.
- Bránou kvality neprošly: golem (3× `inconsistent face winding`) · golf ball (dvakrát předkontrola „golf ball“, ale označený jako rozbitý, třetí pokus brána).
- Předkontrola odmítla všechny tři obrázky: dumpling: bamboo steamer / steamed dumpling – správné jméno, ale obrázek označený jako rozbitý (třetí pokus brána).

**Dávka 5** (magazine … pinecone; v P45E 0/10 soudem, 4/10 předkontrolou a branou):
- Povýšeno (1): top1 milk („milk carton“).
- Soudce poznal něco jiného: magazine: book · moon rover: monster truck (dune buggy ve výčtu, jako P45E) · newspaper: ATM · notebook: trash bin · peacock: flower, označený jako rozbitý (ocas složený, bránou prošel, soudem ne) · pinata: two-headed horse.
- Předkontrola odmítla všechny tři obrázky: pinecone: **pine cone** ×3 – správně, ale předkontrola porovnává slovo „pinecone“ s „pine cone“ jako jiné jméno (stejná třída jako cyclops) · marshmallow: figurine / marshmallow / marshmallows (správné jméno, obrázky označené jako rozbité) · pebble: egg / gravestone / egg.
