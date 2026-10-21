# P57 – modely a světy v top kvalitě

Měření a soudy P57: které modely porotce vidí nejčastěji, jak je soudci hodnotí, co se přegenerovalo a jak vypadají scény 12 vět auditu před a po.

## Výchozí snímky (T1)

- **Věty:** `audit-12.json` – 12 vět auditu dema z 21. 10. 2026 (žába, zombie, ninja, žralok, pizza, kočka, brankář, drahokamy, astronaut, kuchař, bubeník, strašidelný dům).
- **Skript:** `node scripts/p57/snap-audit.mjs --base <url> --out <dir>` nad `npm run build` + `node node_modules/next/dist/bin/next start`.
- **Co fotí:** každou větu na desktopu 1280×800 a na telefonu 390×844 (dotykový Pixel 7 se zmenšenou plochou), ve 2 s a v 15 s ukázky robota – 48 PNG a `index.json`.
- **Čas je tik simulace, ne čas zdi:** 2 s = tik 120, 15 s = tik 900 (60 Hz, ruční hodiny `__playShell.byHand`). Snímek před a po výměně modelů tak ukazuje stejný herní stav a liší se jen vzhledem. Hra, která skončí dřív, se fotí v posledním tiku.
- **Jen plátno:** text stránky je skrytý, soudí se scéna a modely, ne rozhraní.
- **Kde leží:** `D:/caches/p57/baseline/` (commit `72665fdc`), po P57 `D:/caches/p57/after/`. Do repa nejdou, jsou velké.
