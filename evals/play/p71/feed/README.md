# P71B – klipy ve feedu: měření

Lokální produkční server (`next start`, port 3021 – 3011 drží Docker), Chromium přes Playwright se skutečným GPU (ANGLE d3d11), bez OpenXR.

## T2 – nahrávání klipu v prohlížeči (`clip-fps.mjs`)

A/B prokládaně, 6 arcade her, Pixel 7 412×915, nový kontext na návštěvu. A = bez `MediaRecorder`, B = aplikace nahrává.

| CPU (CDP) | A fpsP50 | B fpsP50 | uložené klipy | zahozené jako pomalé |
|---|---|---|---|---|
| ×1 | 59,9 | 59,9 | 6/6 (~3 s, ≤ 372 kB) | 0 |
| ×2 | 59,9 | 59,9 | 0/6 | 6 |
| ×4 | 59,9 | 59,9 | 4/6 | 2 |

Před pojistkou (`clip-fps-x4-no-guard.json`) B spadlo na 4 FPS. Nahrává se jen při plynulém náhledu (≥ 55 FPS, `frameMeter`). Když nahrávání plynulost shodí, klip se zahodí a zařízení už nenahrává (`sayplay-clips-slow`).

## T5 – oracle na telefonu a desktopu (`oracle.mjs` → `oracle.json`, `oracle-*.png`)

12 karet feedu kartu po kartě. Každá karta reelu v okně: dva snímky po 500 ms. Náhled „Up next“ (klipy v obraze se střídají): snímky každých 500 ms až 10 s, hýbe se = některý se liší od prvního. Totéž uprostřed swipe (reel o 40 % karty). FPS aktivní karty = medián rAF za 2 s.

**Výsledek (5. 11., se střídáním klipů):**

| | kontrol | hýbe se | FPS aktivní karty | chyby konzole |
|---|---|---|---|---|
| telefon 390×844 | 34 | 33 | 59,9 (všech 12 karet) | 0 |
| desktop 1280×800 | 70 | 70 | 59,9 (všech 12 karet) | 0 |

Nehybná jediná kontrola: živá karta hry `e684987e` uprostřed swipe, kdy je vidět jen spodních 60 % karty. Sonda na téže kartě (6 snímků po 500 ms): celá karta se liší 5/5, spodních 60 % 1/5 – hýbe se horní část (časovač, netopýři), dole stojí scéna. Vlastnost hry, ne klipů.

Chyba konzole `avc1` z prvního běhu po fd48c892 (`avc3`) zmizela.

**e2e proti 3021 (chromium):** `play-feed-perf.spec.ts` zelený, `play-feed-reels.spec.ts` 16/16 (i nový test: ≥ 3 klipy přehrály ≥ 0,5 s za 12 s, nikdy dva viditelné naráz). `play-feed-phone.spec.ts` 2 červené – **stejně červený i na čistém `main` c7037ab8** (vlastní build, prázdný `PLAY_STORE_DIR`, port 3022): telefon „card 3 (swipe): no running preview of null within 45000 ms“, desktop „expected preview, received play“ po pohybu kolečkem. Obě po 2. kartě vestavěného poolu „Mini Golf Pirate Ship“; pool přeuspořádal P70C 4. 11., test počítá s arénou na 3. místě (naposledy upravený 30. 10.). Předexistující, ne P71B.

**R1 (a832b034) – příčina a oprava:** robot v náhledu minigolf míček potopí uvnitř okna; v pauze 600 ms na konci okna přestal běh `running`, zmizela značka `play-demo`, feed četl „play“ a CSS reel zamklo (`overflow: hidden`) – swipe neprošel, karta po kolečku hlásila „play“ (sonda: `preview` → `play` na tiku 432 → `preview`, 0 vstupů). Značka teď drží celý náhled; přebití `touch-action: pan-y` v náhledu platí i pro vrstvy uvnitř scény (`minigolf-pull` má vlastní `none`). Po opravě `play-feed-phone.spec.ts` 2/2 zelený (prázdný `PLAY_STORE_DIR`), perf + reels 18/18; nový test „never locks“ byl před opravou červený.

### První běh (před střídáním)

| | kontrol | hýbe se | FPS aktivní karty | chyby konzole |
|---|---|---|---|---|
| telefon 390×844 | 34 | 33 | 59,9 | 1 (`avc1` u nahrávače) |
| desktop 1280×800 | 70 | 68 | **30** | 0 |

**Desktop 30 FPS = klipy** (A/B, `ORACLE_NO_CLIPS=1`, 3 karty, 2 páry): s klipy 30, bez klipů 59,9. Rozpad (jedna stránka, videa pouštěná ručně):

| hrají | FPS |
|---|---|
| nic | 59,9 |
| soused v reelu (mimo obraz) | 59,9 |
| jeden náhled „Up next“ | 59,9 |
| soused + jeden náhled | 59,9 |
| dva náhledy „Up next“ | 30 |
| tři náhledy (dnešní stav) | 30 |

Rohy bez zaoblení, `object-fit: fill` ani synchronní start videí na tom nic nemění.

**Inference:** stačí dvě současně viditelná hrající videa vedle živého WebGL plátna. Zda je to jen headless Chromium bez překryvných vrstev pro video, se odsud změřit nedá.

**Oprava (`CardClip.tsx`, `createClipTurns`):** z klipů v obraze hraje vždy jen jeden a po jedné smyčce předá tah dalšímu; soused v reelu mimo obraz hraje dokola. Strop: jeden viditelný klip naráz – zvednout po měření na skutečném desktopu s překryvnými vrstvami.
