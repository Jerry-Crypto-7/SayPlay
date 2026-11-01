# P68 – deník zapojení

Zapisuje jen P68-I: kdy která hra dorazila do `origin/main` (sha), kdy ji úloha „zapoj X“ zapnula, každá změna pole
`cues` v souboru hry kvůli krádeži vět (změna a důvod, kategorie si ji převezme) a hry, které do 6. 11. 12:00 CET
nedorazily (zapsané jako nesplněné, s datem a sha `origin/main`).

| Datum | Hra | Událost | `origin/main` | Poznámka |
|---|---|---|---|---|
| 2026-11-01 | všech 5 | kostra v T1 (staged, brána aktivace) | 688d989d | – |
| 2026-11-01 | buildshift | `p68-ready` v `origin/main` (#63, #66) | 851c085b | – |
| 2026-11-01 | buildshift | T11: rychlá hra zapnutá (pryč z `ROUTE_PENDING`, modul `ready`, buňka `PRESETS`, znak žánru `serve` v `classify.ts`) | 851c085b | stráž `route-buildshift.json`: wrongRate 200 0,366 = main, se skladatelem 0,354 = main, 0 přesunů mezi starými žánry, 1 přesun na hru (p58b s18, v `acceptable`), dev 8/8, věty kategorie 20/20 |
| 2026-11-01 | buildshift | T11: `cues` zúžené z `shop, diner, cafe, café, bakery, restaurant, serve, customers, run a` na `diner, serve, customers` | 851c085b | krádež bez znaku: `shop` slyší „shopping“ (t022, h34), `café`/`cafe`/`restaurant` vyhrály věty bez slovesa (t083, t087, j02), `run a` slyší „run a marathon“; obchod a stavbu nese znak žánru |
| 2026-11-01 | buildshift | T11: režisér a čtečka **nezapnuté** (zůstává v `DIRECTOR_PENDING` / `READER_PENDING`) | 851c085b | nabídka pohne schématem odpovědi → otisk nahraných odpovědí P46E (`p46-fixtures`) zestárne; nový záznam je placený a strop měřicí knihy `PLAY_EVAL_SPEND_CAP_USD` není nastavený. Řádky `MODE_HINTS` / `GENRE_PITCH`, příklad, 3 nahrané odpovědi a test `p68-buildshift.test.ts` jsou připravené (R5) |
| 2026-11-01 | buildshift | T11: žádosti kategorie zapojené | 851c085b | `COUNT_PARAMS.buildshift.customers`, `GENRE_SETTING` `cozy diner`, `TEMPLATE_TITLE` `shift`, `HUD_COUNTER_LABELS` `served`/`coins`, řádek slovesa „Serve the robots!“, schopnosti (role `customer`/`goods`, životy) |
| 2026-11-01 | buildshift | T11: žádosti kategorie **nezapojené** | 851c085b | výsledková karta „All 10 served“ a skrytá pilulka `served`, cíl vyzvání „Serve 10 in 39.0s“, dolní řada HUD na šířku telefonu, karta „Tap to start“ nad paletou – sdílené HUD všech her, mimo zapojení; VR jen `desk` (integration.md režim nežádá, hra se ve VR nenabízí) |
