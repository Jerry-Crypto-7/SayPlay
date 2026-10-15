# P46I – modely pro prostředí her přes noc

Plán: P46I (interní). Větev `features/P46I-modely-prostredi-2026-10-14` z tipu P46F (`20443ec1`), slučuje se po P46F.

## Cíl

Aspoň **120 nových modelů** v katalogu a každé zpracované prostředí s **≥ 3 rekvizitami**. Rekvizity prostředí (`src/play/arcade/look/setting-kits.json`) vidí každá hra s tím prostředím; slepý soud P46G vyhrál právě hustotou a čitelností místa. Chybějící slova z vět jsou vyčerpaná (`still-missing.mjs` nad P46F vrací jen šum).

Mimo: `src/play/**` kromě regenerace `setting-kits.json` skriptem, `src/components/**`, placená API, zapečetěné sady, hrdinové (mění manifest `src/play`).

## Seznam (`round-nouns.json`)

Prostředí se počítají na integrační větvi P46 (91 prostředí, nese kity P46G, které tahle větev nemá): 20 z nich má dnes ≥ 3 rekvizity.

1. **Nejdřív modely, které katalog už má** – 118 párů prostředí → model v `kit-nouns.json` (`source: p46i-catalog`), bez generování. Samy zvednou prostředí s ≥ 3 rekvizitami z 20 na 80 z 91.
2. **Nová jména pro prostředí** – `kit-1` (prostředí s 1 rekvizitou, 21 jmen) a `kit-2` (se 2, 12 jmen), vždy jen do 4 rekvizit na prostředí. Po povýšení všech: 86 z 91.
3. **Scenérie základních sad vzhledu** – `scenery`, 108 jmen pro 18 sad z `look/index.ts`, po jednom na sadu dokola. Jen modely; zapojení do sad navrhne souhrn (T3), `src/play/**/*.ts` se nemění.
4. **Zbytek P46F** – 31 nezkoušených jmen fronty (`totem pole` vypadlo: integrační větev má `tribal totem pole`), pak 20 jmen, která v P46F neprošla, s jedním opakováním (semínka `a2,b2,a3`).

Celkem 192 jmen (172 prvních pokusů + 20 opakování P46F); s jedním opakováním na jméno až 364 pokusů.

Pravidla seznamu (kontroluje `D:/caches/p46i/build-t1.mjs`):
- žádné jméno ani synonymum se slovem třídy manifestu `scripts/assets/p32-manifest.mjs`;
- žádné jméno ani synonymum, které má katalog této větve nebo větví P46 (štítek, id, synonymum P37D);
- žádné jméno končící na „s“ – `cache.slug` ho zkrátí a id `gen3d-<jméno>` by nesedělo s kitem;
- každé nové jméno má rozlišovací znak v `ops/gen3d/features.toml`, klíč není na větvích P46 (duplicitní klíč TOML po sloučení);
- prostředí, která `src/play/__tests__/look.test.ts` připíchl přesným seznamem (frozen lake, highway, supermarket, canyon, desert canyon, haunted mansion), nedostanou nic.

## Jak se páry dostanou do hry

`scripts/p45h/build-setting-kits.mjs` čte za `evals/play/p45g/kit-nouns.json` i `evals/play/p46i/kit-nouns.json` a výšku kulisy bere z pole `height`. Do tabulky jde jen povýšený model `gen3d-<jméno>` bez `qa:unrecognisable`, takže nové jméno se objeví až po povýšení – smyčka po každém kole skript pustí znovu. Při sloučení s integrační větví se `setting-kits.json` nesloučí ručně, ale vygeneruje znovu.

## Pravidla běhu

- RTX 3090, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Mezipaměť `D:/claude/_gen3d-cache-p46i`, záznam dávek `D:/caches/p46i/round<n>/`.
- **Soudce i předkontrola obrázku = Codex** (`--judge codex`), slepě v prázdném `mkdtemp` jen se `sheet.png`. Strop celého P46I **1500 volání**. Vyčerpaný limit = soubor `LIMIT`, nová dávka se nespouští, soud se zkouší každých 10 minut.
- Po povýšení: vyřazení jmen, která by vzal manifest `src/play`, regenerace tříd pohybu a `setting-kits.json`, sady `src/assets`, `scripts/p37d`, `scripts/assets` a připíchnuté testy `src/play` (včetně `look.test.ts` a `setting-ground.test.ts`). Červené → `promote-batch.mjs --drop` a záznam. Sady počkají, když worktree P46-hratelnost, P46G nebo P46H pouští vitest nebo build.
- license-gate: nové GLB v `public/` a jejich záznamy v `disclosure.json` v tomtéž commitu, jeden commit na dávku.
- **Okno:** po **15. 10. 2026 08:45** se nová dávka nespouští; souhrn nejpozději v 09:15.

Záznam po kolech: `gen-round.md`.

## Druhá vlna (15. 10. 05:20)

První seznam (192 jmen) došel v kole 27 v 05:18, okno běželo do 08:45. Do fronty přibylo 149 jmen (`wave: 2` v `round-nouns.json`, `D:/caches/p46i/build-wave2.mjs`):
- prostředí pod 3 rekvizitami zbylo jediné (treasure cave), doplnily ho 3 modely z katalogu, nové jméno nebylo potřeba;
- 9 prostředí z `evals/play/p45d/missing.json`, která tabulka neměla (sunken city, junkyard garage, wedding, tightrope, mushroom hill, birthday party, lawn, treasure island, snow fort): 8 nových jmen a 19 párů s modely z katalogu;
- 109 jmen scenérie, napřed les, džungle, poušť, město, sníh, pláž a pod vodou;
- 32 překážek a sběratelných věcí žánrů (na řadu už nepřišly).

## Souhrn kola (14.–15. 10. 2026, 21:43–08:49)

| | Jmen | Model (předkontrola a brána) | Slepý soud Codex | Povýšeno |
|---|---|---|---|---|
| P46I vlna 1, první pokus (18 kol) | 172 | 146 | 113 (66 %) | **103 (60 %)** |
| P46I vlna 1, opakování (9 kol; vč. 20 jmen P46F) | 84 | 61 | 34 (40 %) | 31 (37 %) |
| P46I vlna 2, první pokus (10 kol) | 100 | 80 | 55 (55 %) | **53 (53 %)** |
| P46I vlna 2, opakování (3 kola) | 30 | 18 | 5 (17 %) | 4 (13 %) |
| P46F, první pokus (soudce Opus 5.5) | 200 | 170 | 136 (68 %) | 130 (65 %) |
| P45I, první pokus (soudce Codex) | 251 | 207 | 147 (59 %) | 141 (56 %) |

Procenta jsou z počtu jmen. Čísla skriptem `D:/caches/p46i/summary.mjs`, po kolech `gen-round.md`, listy soudce `D:/caches/p46i/round<n>/judge/`.

- **Cíl splněn: 191 nových modelů v katalogu** (1353 → 1544, cíl 120), každý s licencí a původem v `disclosure.json`. 40 kol, kolo 41 už nezačalo (okno 08:45).
- **Po skupinách:**

  | Skupina | Zkoušeno jmen | Povýšeno |
  |---|---|---|
  | rekvizity prostředí s 1 rekvizitou (`kit-1`) | 21 | 18 |
  | rekvizity prostředí se 2 rekvizitami (`kit-2`) | 12 | 7 |
  | prostředí z `missing.json` (vlna 2) | 8 | 4 |
  | scenérie základních sad, vlna 1 | 108 | 80 |
  | scenérie základních sad, vlna 2 | 92 | 53 |
  | zbytek P46F – nezkoušená fronta | 31 | 21 |
  | zbytek P46F – opakování | 20 | 8 |
  | překážky a sběratelné věci (vlna 2) | 0 | 0 |

- **Prostředí s ≥ 3 rekvizitami:** na integrační větvi P46 dnes **20 z 91**. Na této větvi (tabulka bez kitů P46G) 6 z 68 před P46I → **66 z 94** po něm. **Po sloučení s P46** a nové generaci tabulky (sjednocení obou tabulek, `D:/caches/p46i/kits-count.mjs`): **86 z původních 91**, celkem **93 ze 101** prostředí. Pod třemi zůstane jen 5 prostředí připíchnutých v `look.test.ts` (frozen lake, highway, supermarket, canyon, desert canyon – po dvou) a tři nová z `missing.json` (junkyard garage 2, tightrope 2, sunken city 1).
- **Úspěšnost proti P46F a P45I:** první pokus vlny 1 dal 66 % soud / 60 % povýšení (P46F 68 / 65 %, P45I 59 / 56 %), vlna 2 jen 55 / 53 %. *Odhad, neměřeno:* druhá vlna měla drobnější a méně ikonické věci (cedule, budovy, květiny), které soudce z obrázku pozná hůř. Opakování dalo 37 % ve vlně 1 (P46F 36 %, P45I 12 %).
- **Vyřazeno: 5, vše v kole 20** (badger, spike pit, geyser, ankylosaurus, snow pile ze zbytku P46F): po povýšení zčervenal i samostatně `src/play/arcade/__tests__/hero-choice.test.ts`, smyčka proto vyřadila všechny modely kola (`promote-batch.mjs --drop`) a sady pak prošly. Který z pěti modelů test shodil, se nezjišťovalo. Manifestem `src/play` nevypadlo nic a žádné kolo nezčervenalo kvůli `setting-kits.json`.
- **Codex: 963 volání** (předkontroly obrázků i soudy listů) ze stropu 1500, limit ani jednou nedošel.
- **Velikost nových GLB:** lod0 17,3 MB (průměr 91 kB na model), lod1 8,3 MB (průměr 43 kB).
- **Sady v klidu** (po skončení smyčky, GPU stojí): 28 souborů, 1853 testů zelených, `git status` beze změny měřených artefaktů.
- **Pokrytí katalogu** (`npx vitest run --config vitest.measure.mts evals/play/catalog-coverage.measure.ts`): modelů 1544, pokrytí podstatných jmen z vět beze změny (102 ze 114) – měřená sada vět prostředí ani scenérii nejmenuje.
- **Čeká na opakování (nikdy nespuštěno):** fir wreath, beach shower, sunken crate, strangler vine, sea lily, pizzeria sign, pool float, ginger flower, wanted poster, ice slide, hidden temple door, frozen signpost, tide pool rock, vine curtain, boardwalk, ore vein, castle catapult. **Nezkoušených** zůstalo 49 jmen fronty: 17 scenérie (sopka, jeskyně, vesmír, hrad, hřbitov) a všech 32 překážek a sběratelných věcí – `D:/caches/p46i/state.json` a `queue.json` od `queueNext` 292.

### Sporné verdikty soudce

`matches()` v `scripts/p37d/judge-sheet.mjs:73` uzná shodu, když se shoduje **poslední slovo** jména („jaguar statue“ = „dog statue“), a `top3` přijme i alternativu. Codex tak pustil do katalogu modely, které viděl jako něco jiného:
- **top1 přes poslední slovo:** jaguar statue → „dog statue“, taro plant → „monstera plant“, sunscreen bottle → „shampoo bottle“, claw machine → „vending machine“, volleyball net → „tennis net“, jade statue → „Buddha statue“, avalanche fence → „wooden fence“, city map board → „notice board“, cypress tree → „pine tree“;
- **jen alternativou (top3):** rain barrel → „oil drum“, manhole cover → „waffle“, canned soup → „popcorn bucket“, cooling tower → „vase“, lava lamp → „vase“, lunar crater → „stone bowl“, electric generator → „portable heater“, hitching post → „wooden cross“, coral pillar → „totem pole“, stele → „gravestone“, snow shovel → „hand tamper“, storefront → „kiosk“, ticket machine → „parking meter“, coyote → „fox“, puffin → „penguin“.

Doporučení: tyto modely před zapojením prohlédnout (`public/assets/worldstream/gen3d-p37d/gen3d-<jméno>.png`) a nepoznatelné označit `qa:unrecognisable` – tím vypadnou z kitů i z manifestu. Pro další noc zpřísnit `matches()`: shoda posledního slova jen tehdy, když první slova nejsou jiné podstatné jméno.

### Návrh zapojení scenérie základních sad (jen návrh, kód se nemění)

133 povýšených jmen scenérie má v `round-nouns.json` pole `look`. Sady kreslí `LOOKS` v `src/play/arcade/look/index.ts:232–252` (na integrační větvi P46 `:476–496`), modely kulis s výškou v `SCENERY_MODELS` (`:82–157`). Integrační větev má navíc vegetaci ve vrstvách (`FOREST_FLORA :230`, `JUNGLE_FLORA :261`, `MEADOW_FLORA :292`, `DESERT_FLORA :317`, `BEACH_FLORA :338`, `SNOW_FLORA :359`), kam patří rostliny. Zapojovat až po sloučení s P46 a až po prohlédnutí – sporné modely výš vynechat.

| Sada | Do vegetace (FLORA, near/mid) | Do `props` sady (+ výška v `SCENERY_MODELS`) |
|---|---|---|
| forest | fern, mushroom cluster, wild strawberry plant; mid birch sapling | standing stone, forest shrine, log bench |
| jungle | bromeliad, anthurium, heliconia, pitcher plant, rafflesia, giant leaf | mossy ruin pillar, bamboo hut, jungle waterfall, tribal shield |
| meadow | daisy, poppy flower, buttercup | wooden gate, picnic table, wooden stile, garden arch |
| desert | desert shrub; mid yucca plant, mesquite tree | buried statue head, western saloon, stone cairn, abandoned mine entrance, clay pot |
| beach | – | beach cabana, beach chair, surf rack, pier lamp, driftwood |
| snow | – | snowy bench, ice arch, snow cannon, snowy mailbox, frozen log |
| underwater | – | staghorn coral a kelp místo primitiv `coral`/`seaweed`, coral arch, barnacle rock, sunken bell, helm wheel |
| city | – | telephone pole, neon sign, street bollard, pay phone, flower stall |
| ocean | – | navigation buoy místo primitivu `buoy`, sea arch, floating dock, oil rig |
| factory | – | smokestack místo primitivu `chimney`, gas cylinder, industrial fan |
| living_room / supermarket / mall | – | side table, wall clock, coat rack, gramophone / bread rack, candy display / claw machine (po prohlédnutí), gumball machine |
| volcano / cave / space | – | steam vent, magma rock / stalagmite, glowing mushroom, crystal geode / fuel silo, moon flag |
| castle / graveyard | – | castle tower místo primitivu `tower`, battlement wall, stone gatehouse / cemetery gate, iron fence, grave lantern |

Podmínky z testů: každé id v `SCENERY_MODELS` musí být v katalogu (`look.test.ts`, „kulisy z katalogu“) a počet kulis sady se nesmí změnit, kit stojí *místo* části sady („kit stojí místo části sady“) – nový model tedy nahrazuje primitiv nebo jiný model, nepřidává se navíc. Ověřit pohledem na vykreslenou scénu (slepý soud jako P46G), ne jen testy.
