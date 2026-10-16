# P47C – modely přes noc se soudcem Opus 5.5

**Cíl:** za jednu noc (15.–16. 10. 2026) vygenerovat, slepě posoudit a povýšit modely s největším dopadem na hru: věci ke sbírání a cíle pro arena-collect a quest, předměty finále pro arena-collect, quest, duel a throw, znovu 24 modelů, které P46J vyřadila jako napůl poznané, a scenérii pro prostředí a základní sady vzhledu.

**Soudce:** Opus 5.5 (`--judge claude`) v předkontrole obrázku i ve slepém soudu listu – `claude -p --model claude-opus-5-5` v prázdném `mkdtemp`, jen `sheet.png`, jediný nástroj `Read`. Strop ~2000 volání. Došlý limit předplatného = smyčka čeká a zkouší soud každých 10 minut, nová dávka se nespouští.

**Přísnější shoda:** `matches()` v `scripts/p37d/judge-sheet.mjs` od P47C uzná stejné poslední slovo jen tehdy, když ostatní slova odpovědi jsou ze jména nebo jen popisují vzhled (barva, materiál, velikost). „dog statue“ už není „jaguar statue“, „wooden bench“ dál je „snowy bench“.

## Seznam (`round-nouns.json`, 316 jmen v pořadí fronty)

| Skupina | Jmen | Co |
|---|---|---|
| `p46i-pickup`, `p46i-obstacle`, `p46i-scenery` | 13 + 19 + 17 | nezkoušená jména P46I |
| `p46i-retry` | 17 | jména P46I, která čekají na jediné opakování (nová semínka) |
| `goal` | 37 | cíle a předměty finále: stupně vítězů, trofeje, pás šampiona, ring, gong, terče a pyramidy plechovek, podstavce s koulí, studny, trůny a koruny podle sady |
| `collect` | 74 | věci ke sbírání podle sady vzhledu (17 sad, po jedné sadě dokola) |
| `p46j-redo` | 24 | modely vyřazené P46J, znovu s ostřejším znakem v `ops/gen3d/features.toml` (komentář říká, co v nich viděl Codex) |
| `remake` | 2 | rafflesia a desert shrub – nový znak, povýšený model nahradí stejné id |
| `sparse-setting` | 11 | rekvizity pro junkyard garage, tightrope, sunken city (pod 3 rekvizitami) |
| `scenery` | 102 | scenérie základních sad, kde je místo i v `setting-kits.json` |

Neprošlé jméno dostane jedno opakování s novými semínky (`a2,b2,a3`), takže noc zpracuje přes 400 jmen. Každé nové jméno má znak ve `features.toml`, žádné nemá slovo třídy manifestu (`scripts/assets/p32-manifest.mjs`) a žádné katalog nezná (kontrola i přes katalogy větví P46 a P47).

**Rekvizity prostředí:** `kit-nouns.json` (čte ho `scripts/p45h/build-setting-kits.mjs` po P45G a P46I): 2 páry s modely, které katalog už má (unicycle – tightrope, sunken bell – sunken city), 3 páry, které P46J vzala s modely (rain barrel, cypress tree, ticket machine) a 36 jmen scenérie pro prostředí se 3 a méně rekvizitami. Prostředí připíchnutá v `look.test.ts` nedostanou nic.

**Synonyma soudu:** `aliases.json` = P46I + synonyma P47C. Synonymum se stane štítkem katalogu, takže jednoslovná obecná slova („table“, „net“, „sign“) vynechaná.

## Pravidla běhu

Jako P46I (`D:/caches/p46i/loop.mjs`): kolo 10 jmen ≈ 15 min, generování dalšího kola běží během soudu předchozího, po povýšení se regenerují třídy pohybu a `setting-kits.json`, sady `src/assets`, `scripts/p37d`, `scripts/assets` a testy vzhledu a katalogu, license-gate v pre-commit hooku, jeden commit na kolo `feat(assets): promote P47C models, batch <n>`. Červená sada samotná → modely kola vyřazené. Záznam kol `gen-round.md`, záznamy `D:/caches/p47c/round<n>/`, mezipaměť `D:/claude/_gen3d-cache-p47c`.

## Výsledek noci (kola 1–38, 15. 10. 21:56 – 16. 10. 08:12)

**Cíle splněné:** katalog 1608 → **1766 modelů (+158)**, povýšeno 160 jmen (rafflesia a desert shrub nahradily stejné id). Junkyard garage 2 → 5 rekvizit, tightrope 3 → 4, sunken city 2 → 3. Prostředí s ≥ 3 rekvizitami 94 → 96 ze 101; pod třemi zůstává frozen lake, highway, supermarket, canyon a desert canyon (po 2). Nové GLB: lod0 14,4 MB (průměr 91 kB), lod1 6,9 MB (44 kB). Opus 5.5 dostal **942 volání** (předkontrola + soud), strop 2000 ani limit předplatného nepadl.

Pokrytí vět (`catalog-coverage.measure.ts`): jména 102/114 a zmínky 143/160 jako před nocí – nové modely jsou varianty podle sady, ne nová slova z vět.

| Běh | Kol | Jmen | Model | Soud | Povýšeno |
|---|---|---|---|---|---|
| **P47C, první pokus** | 26 | 259 | 202 | 153 (59 %) | **135 (52 %)** |
| P47C, opakování | 12 | 117 | 63 | 31 (26 %) | 25 (21 %) |
| P46I vlna 1 / vlna 2, první pokus (Codex) | 18 / 10 | 172 / 100 | 146 / 80 | 66 % / 55 % | 60 % / 53 % |
| P46F, první pokus (Opus 5.5) | – | 200 | 170 | 68 % | 65 % |

*Odhad, neměřeno:* nižší úspěšnost než P46F dělá hlavně přísnější `matches()` (níže) a skupiny, které už jednou propadly (`p46j-redo`, `p46i-obstacle`).

| Skupina | Zkoušeno | Povýšeno |
|---|---|---|
| `goal` | 37 | **27 (73 %)** |
| `collect` | 74 | **52 (70 %)** |
| `p46i-pickup` | 13 | 9 (69 %) |
| `scenery` | 62 | 40 (65 %) |
| `p46i-scenery` | 17 | 8 (47 %) |
| `sparse-setting` | 11 | 5 (45 %) |
| `p46i-retry` | 17 | 7 (41 %) |
| `p46i-obstacle` | 19 | 6 (32 %) |
| `p46j-redo` | 24 | 4 (17 %) |
| `remake` | 2 | 2 |

Ostřejší znak ve `features.toml` vyřazeným modelům P46J skoro nepomohl (4 z 24) – tahle jména nemá cenu zkoušet potřetí stejnou cestou.

**Přísnější `matches()`:** 18 odpovědí by stará shoda přijala a nová odmítla. *Odhad podle odpovědí:* 11 odmítnutí je správných (golden ring → „life ring“, spinning bar → „tap wrench“, pressure plate → „concrete base“, star chart → „scroll“, space antenna → „candle stand“, jade statue → „dragon statue“ 2×…), 7 je přísných na správný předmět (electric pylon → „transmission tower“, cave bridge → „rope bridge“, armor rack → „armor stand“, pizzeria sign → „pizza sign“, electric generator → „portable generator“, sunken pillar → „ruined pillar“, sunken arch → „stone archway“) – na ty stačí synonymum v `aliases.json`.

### Co může P47A použít hned (id podle sady)

**Cíle a předměty finále** (`goal`):
- kdekoli: `gen3d-victory-podium`, `gen3d-star-trophy`, `gen3d-finish-banner`, `gen3d-laurel-wreath`, `gen3d-blue-ribbon`, `gen3d-boxing-ring`, `gen3d-gong`, `gen3d-arena-gate`, `gen3d-bullseye-target`, `gen3d-carnival-target`, `gen3d-carnival-booth`, `gen3d-prize-wheel`, `gen3d-orb-pedestal`, `gen3d-crystal-pedestal`, `gen3d-map-piece`, `gen3d-magic-fountain`, `gen3d-wishing-well`, `gen3d-fencing-mask`
- castle `gen3d-sword-in-the-stone`, `gen3d-holy-grail` · factory `gen3d-golden-gear` · forest `gen3d-golden-acorn`, `gen3d-enchanted-stump` · graveyard `gen3d-haunted-crown` · snow `gen3d-ice-throne` · underwater `gen3d-trident-statue` · volcano `gen3d-fire-crown`

**Věci ke sbírání** (`collect`), všech 17 sad má aspoň jednu:

| Sada | Id |
|---|---|
| beach | `gen3d-treasure-sack` |
| castle | `gen3d-gem-ring`, `gen3d-enchanted-sword`, `gen3d-jester-hat` |
| cave | `gen3d-crystal-heart` |
| city | `gen3d-subway-token`, `gen3d-arcade-token` |
| desert | `gen3d-ankh`, `gen3d-cactus-fruit`, `gen3d-fossil`, `gen3d-golden-scarab`, `gen3d-canopic-jar` |
| factory | `gen3d-bolt`, `gen3d-microchip`, `gen3d-oil-can` |
| forest | `gen3d-berry-basket`, `gen3d-firefly-jar`, `gen3d-maple-leaf` |
| graveyard | `gen3d-candy-corn`, `gen3d-bone-key`, `gen3d-pumpkin-lantern` |
| jungle | `gen3d-banana-bunch`, `gen3d-tribal-mask`, `gen3d-jade-skull` |
| living_room | `gen3d-remote-control`, `gen3d-toy-block`, `gen3d-spinning-top` |
| mall | `gen3d-perfume-bottle`, `gen3d-gift-bag`, `gen3d-vinyl-record` |
| meadow | `gen3d-cake-slice`, `gen3d-cotton-candy`, `gen3d-candy-apple`, `gen3d-macaron` |
| snow | `gen3d-hot-cocoa-mug`, `gen3d-sleigh-bell`, `gen3d-ice-key`, `gen3d-snowflake-token` |
| space | `gen3d-energy-crystal`, `gen3d-space-helmet`, `gen3d-power-core` |
| supermarket | `gen3d-candy-bar`, `gen3d-cheese-wedge`, `gen3d-grocery-bag`, `gen3d-watermelon-slice`, `gen3d-egg-tray` |
| underwater | `gen3d-gold-doubloon`, `gen3d-shell-necklace`, `gen3d-coral-crown` |
| volcano | `gen3d-obsidian-shard`, `gen3d-fire-gem`, `gen3d-magma-crystal` |

Ocean nemá vlastní věc ke sbírání; v cílech chybí sady beach, cave, city, desert, jungle, living_room, mall, meadow, space, supermarket (mají jen obecné cíle „kdekoli“).

### Co zbylo na další noc

- **Čeká na jediné opakování (13):** coffin lid, haunted lantern, sea wall, berry bush, forest lantern, wooden totem, desert skull, adobe hut, hieroglyph tablet, bamboo grove, ice sculpture, snow drift, ice pillar.
- **Nezkoušeno, fronta došla časem (40):** scenérie snow, city, supermarket, factory, living_room, castle, volcano a meadow (ice cave entrance … milk churn, `D:/caches/p47c/queue.json` od pozice 276).
- **Po opakování dál mimo katalog:** 92 jmen, mezi nimi z cílů champion belt, sumo ring, milk bottle pyramid, tin can stack, confetti cannon, quest board, frozen trophy, ice crown, warp portal, sunken throne a z věcí ke sbírání drahokamy (amethyst, topaz, sapphire, frozen gem), giant pearl, soul orb, present box. Úplný seznam vypíše `node --experimental-strip-types D:/caches/p47c/summary.mjs <stará judge-sheet.mjs>`.
