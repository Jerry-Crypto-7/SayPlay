# P57 – modely a světy v top kvalitě

Měření a soudy P57: které modely porotce vidí nejčastěji, jak je soudci hodnotí, co se přegenerovalo a jak vypadají scény 12 vět auditu před a po.

## Výchozí snímky (T1)

- **Věty:** `audit-12.json` – 12 vět auditu dema z 21. 10. 2026 (žába, zombie, ninja, žralok, pizza, kočka, brankář, drahokamy, astronaut, kuchař, bubeník, strašidelný dům).
- **Skript:** `node scripts/p57/snap-audit.mjs --base <url> --out <dir>` nad `npm run build` + `node node_modules/next/dist/bin/next start`.
- **Co fotí:** každou větu na desktopu 1280×800 a na telefonu 390×844 (dotykový Pixel 7 se zmenšenou plochou), ve 2 s a v 15 s ukázky robota – 48 PNG a `index.json`.
- **Čas je tik simulace, ne čas zdi:** 2 s = tik 120, 15 s = tik 900 (60 Hz, ruční hodiny `__playShell.byHand`). Snímek před a po výměně modelů tak ukazuje stejný herní stav a liší se jen vzhledem. Hra, která skončí dřív, se fotí v posledním tiku.
- **Jen plátno:** text stránky je skrytý, soudí se scéna a modely, ne rozhraní.
- **Kde leží:** `D:/caches/p57/baseline/` (commit `72665fdc`), po P57 `D:/caches/p57/after/`. Do repa nejdou, jsou velké.

## Použití modelů (T2)

`usage.json` z `node scripts/p57/usage-tally.mjs`: 227 scén (p30 dev, p54c dev, p55 holdout otevřený, 12 vět auditu; 5 vět mimo prohlížeč přeskočeno), 402 použitých modelů katalogu z 1 766. Top 300 podle počtu scén, vzorek 100 z ostatních (`pure-rand`, semínko 57). Riggované postavy (`rigged:*`) a primitiva jsou v `unknown` – P57 je neumí soudit ani vyměnit.

## Soud knihovny (T4)

`node scripts/p57/judge-library.mjs` → `judge.json` (21. 10. 2026, commit `d25870f8`).

- **Listy:** 45 mřížek 3×3 v pořadí použití, buňka = ¾ pohled, číslo a rozměry, žádné jméno. Modely, které hry ukazují hlavně jako vegetaci, mají šedé listí přebarvené na listí louky `#4f9a3a` jako ve hře (`plantPaint`); bez toho dostala šedá tráva a bříza 4 body za barvu, kterou hráč nevidí.
- **Soudci:** liché listy Codex, sudé Opus 5.5, každý desátý oba. Codex 28 volání (strop 30/den, počítadlo `codex-calls.json`, včetně 2 zkušebních listů). Každý soudce viděl jen `sheet.png` v prázdném adresáři.
- **Přečteno:** 400/400 modelů, žádná buňka `null`.
- **Shoda soudců:** 36 buněk překryvu, 36 s rozdílem ≤ 2 body (100 %), průměrný rozdíl 0,86 bodu. Brána 80 % prošla, kalibrace nebyla potřeba.
- **Rozdělení:** top 300 medián 6, průměr 5,97, pod 6: 124, aspoň 8: 73. Vzorek 100 medián 6, průměr 5,68, pod 6: 48, aspoň 8: 16.
- **Vstupy přegenerování:** `below6` 172 modelů (T6 bez top 50), `top50Below8` 41 z top 50 (T8).

**Inference:** nejpoužívanější modely jsou jen o málo lepší než ocas (5,97 proti 5,68), takže levný vzhled scén nejde na vrub pár výjimek, ale celé knihovny.
