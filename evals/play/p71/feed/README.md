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

12 karet feedu kartu po kartě. Každá karta a náhled „Up next“ v okně: dva snímky po 500 ms. Totéž uprostřed swipe (reel o 40 % karty). FPS aktivní karty = medián rAF za 2 s.

| | kontrol | hýbe se | FPS aktivní karty | chyby konzole |
|---|---|---|---|---|
| telefon 390×844 | 34 | 33 | 59,9 (všech 12 karet) | 1 (`avc1` u nahrávače – opraveno ve fd48c892, zatím neověřeno novým během) |
| desktop 1280×800 | 70 | 68 | **30** (všech 12 karet) | 0 |

Nehybné: hra `e684987e` uprostřed swipe (vidět jen spodních 60 % karty, mimo swipe se hýbe) a jeden náhled „Up next“ na 4. kartě.

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

## Zbývá (T5)

- Viditelné klipy se střídají, hraje vždy jen jeden. Videa mimo obraz v dosahu (soused v reelu) hrají dál, nic nestojí. Pak znovu `oracle.mjs`: desktop ≥ 55 FPS a ověření, že chyba `avc1` zmizela.
- `e2e/play-feed-perf.spec.ts` a `e2e/play-feed-phone.spec.ts` zatím neběžely.
