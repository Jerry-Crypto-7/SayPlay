# P45H – scenérie podle prostředí

Plán: P45H (interní). Větev převzala fast-forwardem lokální `features/P45G-modely-prostredi-2026-10-11` (`50796f7d`) – slučuje se **po P45G**, ten po P45F.

## Co plán řeší

- **Problém (P45G T4):** věta, která jmenuje jen prostředí („ice fishing on a frozen lake“), nové rekvizity P45G nenačte. Scenérii vybírá pevná tabulka 17 sad v `src/play/arcade/look/index.ts` (`KEYWORDS` → `LOOKS` → `SCENERY_MODELS`), takže 74 nových modelů uvidí hráč jen ve větě, která je jmenuje.
- **Řešení:** tabulka prostředí → rekvizity (`src/play/arcade/look/setting-kits.json`), postavená skriptem z mapy `evals/play/p45g/kit-nouns.json` a katalogu, jen z povýšených modelů. Scéna podle ní rozmístí rekvizity kitu místo části rekvizit sady – počet objektů ve scéně se nezvětší.
- **Cíl:** věta, která jmenuje jen prostředí z kitu, ukáže ve scéně aspoň 2 jeho rekvizity; replay hash a stávající sady beze změny.
- **Mimo:** generování modelů (souběžný P45I), placená API, zapečetěné sady, režisér a jeho prompt.

## Na čem stojí

- `evals/play/p45g/kit-nouns.json` – 159 jmen, u každé rekvizity prostředí, ke kterým patří.
- `src/assets/catalog.json` – které z nich prošly soudem a jsou povýšené (74 nových modelů P45G).
- Determinismus podle `CLAUDE.md`: výběr a rozmístění jen přes `pure-rand` stream scenérie, nic z toho nesmí do hashovaného stavu.

## Co se změnilo (T2, T3)

- **Tabulka** `src/play/arcade/look/setting-kits.json` – 53 prostředí, 71 modelů, 20 prostředí se ≥ 2 rekvizitami. Píše ji `node scripts/p45h/build-setting-kits.mjs`; druhý běh je beze změny, po sloučení P45I se pustí znovu. Výšky kulis jsou ruční (katalog má modely gen3d srovnané na výšku 1 m); jméno bez ruční výšky dostane výšku podle třídy a skript ho vypíše.
- **Výběr** `kitFor(setting)` v `src/play/arcade/look/index.ts`: nejdelší shoda vyhrává („desert canyon“ před „canyon“), žádná shoda = prázdný kit. `lookFor`/`lookOf` vybírají sadu jako dřív.
- **Scéna** `sceneLook` střídá rekvizity kitu a sady; počet kulis ve scéně dává délka trati, ne seznam, takže se nezvětší. Seznam má sudou délku 4–8: `sceneryPlaces` jde po rekvizitách krokem 7, takže ze sady o sedmi rekvizitách (mall, snow, space) dřív stály ve scéně jen první a poslední.
- Výběr ani rozmístění nepoužívá náhodu – čistá funkce textu prostředí, nic z toho nejde do hashovaného stavu.
- **Odchylka od plánu:** „a meadow“ prázdný kit nemá – mapa P45G dává louce pampelišku. Prázdný kit pinuje kontrolní věta „a dog runs in a park“.

## Kontrola ve hře (T4, 11. 10. 2026 22:05–22:45)

Build P45H (`1413c7de`, po opravě mansion `f6a06c36`) proti `50796f7d` (P45G, dočasný worktree) – oba `npm run build` + `next start`, bez modelu (hra jde přes návrh, jako v P45G T4). Věta poslaná přes `/api/play/games`, hra otevřená v headless Chromiu, spuštěná, snímek po 6 s hraní, zapsané všechny načtené GLB. Buildy se střídají v pořadí, ať zátěž stroje dopadne na oba stejně. Sonda `D:/caches/p45h/probe.mjs`, výsledky `D:/caches/p45h/probe-r1.json` (SwiftShader jako v P45G T4) a `D:/caches/p45h/gpu/probe.json` (RTX 3090 přes ANGLE).

| Věta | Hra | Kit načtený (P45H) | Kit vidět na snímku | Snímek |
|---|---|---|---|---|
| ice fishing on a frozen lake | mřížka (switch_puzzle) | ice fishing hut, ice floe | **ne** – kamera mřížky kulisy neukáže | `D:/caches/p45h/p45h-ice-fishing-on-a-frozen-lake-6s.png` |
| race cars on the highway | závod | toll booth, highway sign | **ano** – budky se závorou a cedule nad silnicí po obou stranách | `D:/caches/p45h/p45h-race-cars-on-the-highway-6s.png` |
| a cat runs through a supermarket | běžec | checkout counter, shopping basket | **ano** – pokladny a košík, regály sady zůstaly | `D:/caches/p45h/p45h-a-cat-runs-through-a-supermarket-6s.png` |
| escape the haunted mansion | běžec | candelabra, chandelier, grandfather clock | **ano** – lustry a hodiny podél trati, na zelené louce | `D:/caches/p45h/gpu/p45h-escape-the-haunted-mansion-6s-gpu-r1.png` |
| zombie shooter in a mall | střelnice | escalator, mannequin, clothing rack | **ano** – eskalátory, figuríny a stojan s oblečením | `D:/caches/p45h/p45h-zombie-shooter-in-a-mall-6s.png` |

- **4 z 5 vět ukážou ≥ 2 rekvizity kitu, cíl plánu splněný u 4 z 5.** Na P45G žádná z pěti vět rekvizitu kitu nenačte.
- **Mřížka (frozen lake):** kit se načte, ale kamera mřížky se dívá shora na arénu a kulisy stojí za její zadní stěnou – mimo snímek. Na P45G je snímek stejný (kulisy sady také nejsou vidět), takže jde o rámování mřížky, ne o tabulku.
- **Mansion:** návrh z „escape the haunted mansion“ píše místo jen „mansion“, takže kit se napoprvé nechytil. Oprava `f6a06c36`: synonymum „mansion“ pro kit haunted mansion. Sada zůstává louka – `lookFor` „mansion“ nezná a plán výběr sady neměnil.
- **Kontrolní věta „a dog runs in a park“** načte na obou buildech stejných 8 GLB.
- **Hash hry** (`versionId`) je u všech šesti vět na obou buildech stejný – stav hry se nezměnil.
- Střelnice se přes `__playShell.start()` nespustila (snímek ukazuje „Tap to start“); scenérie je vidět i tak.

### První snímek a FPS (RTX 3090, medián ze 3 opakování, supermarket ze 7)

| Věta | První snímek P45H / P45G (ms) | FPS P45H / P45G |
|---|---|---|
| ice fishing on a frozen lake | 966 / 1302 | 55,6 / 55,6 |
| race cars on the highway | 1190 / 862 | 55,9 / 54,9 |
| a cat runs through a supermarket | 794 / 893 | 60 / 57,8 |
| escape the haunted mansion | 1181 / 1301 | 56,7 / 57 |
| zombie shooter in a mall | 1073 / 1430 | 60 / 59,9 |
| a dog runs in a park | 1098 / 1353 | 49 / 49,6 |

- P45H měřený na buildu `f6a06c36`. Karta byla po celou dobu sdílená s generováním P45I (vytížení 78–87 %), první opakování mají FPS 14–50 na obou buildech, pak oba narazí na strop 60. **Rozdíly jsou v šumu, P45H není horší.**
- SwiftShader (jako v P45G T4) dává na zatíženém CPU 0,5–2 FPS na obou buildech – na srovnání nepoužitelné, snímky z něj ano.

### E2E sady, kterých se scenérie dotýká

`FALLBACK_SMOKE_URL` na build `f6a06c36`, projekt `chromium`, bez `@measure`: p30b-camera-frame, p30b-settings, p32-arena, p32-first-seconds, p32-penguin, p32-quest, p32-split, p32-terrain-gallery, play-audio, play-cast, play-env, play-postrun, play-scenery-gallery, play-setting.

- **První běh: 74 prošlo, 16 přeskočeno, 13 červených** – všech 13 padlo na nastavení serveru, ne na změně:
  - `p32-terrain-gallery` (12×) – stránka laboratoře `/play/lab/terrain` je v produkci 404, spec chce server spuštěný s `PLAY_LAB=1`.
  - `play-env` „custom panorama“ (1×) – server neměl adresu služby panoramat (`PLAY_ENV_ENDPOINT` + `PLAY_ENV_KEY` na podvrh, který spec sám spustí), takže zůstal u `meadow-3`.
- **Opakování obou souborů** na stejném buildu se serverem `PLAY_LAB=1`, `PLAY_ENV_ENDPOINT=http://127.0.0.1:3296`, `PLAY_ENV_KEY=e2e-env-key` a `E2E_ENV_STUB_PORT=3296` (3295 držel běh jiné relace): **16/16 zelených** (`D:/caches/p45h/e2e-rerun.log`).
- **`play-scenery-gallery`** (bez `P28_SCENERY_DIR` se přeskočí) puštěná zvlášť: 12/12, snímky v `D:/caches/p45h/scenery-gallery/`. Kit dostanou jen dvě věty, obě s prostředím „meadow“ (pampeliška): j01 ji ukazuje za zdí arény vedle rekvizit sady, x-grid je mřížka a kulisy nerámuje. Ostatní scény kit nemají a vypadají jako dřív; „walk my dog along the beach…“ stojí na sněhu, protože návrh pro ni píše `look: snow` – starší chování, ne P45H.
- Sady přepsaly 56 sledovaných snímků a manifestů v `evals/play/p30b`, `p32`, `p39`, `p41`, opakování dalších 10 v `p32/terrain` a `p41/env` – vše vrácené `git checkout`, v commitu nejsou.

## Doporučení

1. **Kulisy mřížky v záběru:** hry na mřížce (frozen lake = switch_puzzle) kulisy nikdy neukážou, kit ani sadu – stojí za zadní stěnou arény. Další plán: posunout část kulis do rohů záběru, nebo ukázat kit při úvodním průletu kamery.
2. **Sada pro „mansion“:** `lookFor` „mansion“ nezná, takže sídlo stojí na zelené louce. Přidat „mansion“ do `KEYWORDS` (graveyard) změní sadu i u starších her – rozhodnutí mimo tenhle plán.
3. **Po sloučení P45I** pustit `node scripts/p45h/build-setting-kits.mjs` – nové modely kitů se do tabulky dostanou samy, výšky nových jmen doplnit do `HEIGHTS`.
