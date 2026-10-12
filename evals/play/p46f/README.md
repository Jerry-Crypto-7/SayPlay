# P46F – modely pro hratelnost přes noc

Plán: P46F (interní). Větev převzala fast-forwardem lokální integrační větev `features/P46-hratelnost-2026-10-12` (`491079b7`, obsahuje P45G a P45I). Do P46 se slučuje jako poslední, nebo kdykoli mezi A → B → D → C → E – sahá jen na katalog a assety.

## Cíl

Aspoň **80 nových modelů** v knihovně, z toho aspoň **15 bossů** a **20 věcí pro akce hrdiny**. Pořadí podle dopadu na hru z P46:

1. **Bossové** pro finále (P46B, P46E) – pronásledovatel běžce, který útočí; vrtulník a jiný stroj nad tratí pro řízení; šéf na konci skákačky; velké a hrozivé verze tvorů a strojů, které věty jmenují jako nepřítele.
2. **Věci pro akce P46A** – zbraně, střely, štíty, power-upy (magnet, štít, 2×), kořist ke krádeži.
3. **Nepřátelé, překážky a sběratelné věci**, které věty chtějí a knihovna nemá (`evals/play/p45d/missing.json`, panely P45/P46).
4. **Chybějící hrdinové.**

Mimo: `src/play/**` a `src/components/**` (tam běží P46A/B/D), placená API, zapečetěné sady (`evals/play/p30/`), rigování.

## Pravidla běhu

- Karta RTX 3090, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Mezipaměť `D:/claude/_gen3d-cache-p46f` (mezipaměti P45G a P45I se smí číst), záznam dávek `D:/caches/p46f/round<n>/`.
- **Soudce i předkontrola obrázku = Opus 5.5** přes `claude -p --model claude-opus-5-5` na předplatné. Slepý soud v prázdném `mkdtemp`, jediný soubor `sheet.png`, povolený nástroj jen `Read` – soudce nevidí jméno předmětu ani cestu, která by ho prozradila.
- Strop celého P46F **1200 volání** soudce. Vyčerpaný limit předplatného = zbytek „čeká na soud“, smyčka počká na obnovení (čas z hlášky) a pokračuje.
- Povýšení nesmí změnit výsledek testů v `src/play`; když zčervenají, jméno jde ven přes `promote-batch.mjs --drop` a zapíše se jako zjištění.
- license-gate: nové GLB v `public/` a jejich záznamy v `disclosure.json` v tomtéž commitu, jeden commit na dávku.
- Souběžné autopiloty P46B a P46D GPU nepotřebují; sady po dávce počkají, když jejich worktree pouští vitest nebo build (časové testy pod zátěží padají).
- **Okno:** po **13. 10. 2026 06:10** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše. Souhrn hotový nejpozději v 06:40.
