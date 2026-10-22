# P56B – měření „na telefonu“ (emulace, 22. 10. 2026)

**Skutečný telefon nebyl.** Majitel test na telefonu odmítl („udělej to ty nebo to přeskoč“), takže toto je náhrada: Chromium přes Playwright s profilem `Pixel 7` (viewport 412×839, DPR 2,625, UA, dotyk), CPU zpomalené 4× (`Emulation.setCPUThrottlingRate`), GPU skutečná desktopová (RTX 3090 přes ANGLE/D3D11), okno viditelné (ne SwiftShader). Build HEAD větve P56B přes `next start`, overlay `?fps=1` (`src/components/play/FpsProbe.tsx`): průměr FPS za 15 s a `data-quality` na `arcade-stage` na konci okna.

**Zátěž:** během měření běžely souběžně dva další autopiloty, CPU stroje 100 %. Emulace tak měří hlavně procesor pod cizí zátěží, ne GPU telefonu – výsledek je spodní odhad, ne verdikt.

| Věta | Model | Běh 1 | Běh 2 | Běh 3 | Medián FPS | `data-quality` (běhy) |
|---|---|---|---|---|---|---|
| 02-zombie | emulace Pixel 7 | 39,0 | 25,5 | 25,1 | 25,5 | medium, low, low |
| 06-cat | emulace Pixel 7 | 43,4 | 43,1 | 39,2 | 43,1 | medium, low, low |
| 12-ghost | emulace Pixel 7 | 20,4 | 17,8 | 22,5 | 20,4 | low, low, low |

na `medium` drží ≥ 40 FPS: ne – jen 06-cat v prvním běhu (43,4); 02-zombie na `medium` 39,0; ostatní běhy spadly na `low`. Emulace pod 100% zátěží CPU to nerozhoduje: krok (2) z T8 se kvůli ní nespouští, rozhodne až skutečný telefon, pokud ho majitel někdy zahraje.

Skript: `emu-phone.mjs` (scratchpad sezení, mimo repo) – 3 věty po sobě, každá v novém kontextu.
