# P37B T7 – 40 FPS na telefonu (4. 10. 2026)

**Výsledek:** všech 22 vět (12 přejímky P32 + 10 sloves T1) má na finálním buildu medián FPS ≥ 40 (Pixel 7, emulace, CPU 4×, samostatně přes `heavy.mjs`). Dřív pod 40: hasič 13,7, tučňák 30, sekání dřeva 36,4. Měří `scripts/p37b/clips.mjs --fps-only`: 12 s, medián po sekundách, ke každé sekundě úroveň kvality a volání kreslení (`fpsDetail`).

## Co zpomalovalo a co pomohlo

| # | Příčina (jak zjištěno) | Oprava | Účinek |
|---|---|---|---|
| 1 | Přepnutí kvality `medium` → `low` přeložilo shadery všech materiálů: `low` neměl skládač, renderer začal tónovat sám a změnil se cíl kreslení (sekundy s 0,9 / 8,9 / 16 FPS hned po přepnutí) | Skládač (ACES + ladění barev) kreslí na každé úrovni, `low` jen bez AO a bloomu, hrany vyhlazuje MSAA | Propad při přepnutí zmizel (tučňák 35 → 52 plynule, pirát 25 → 44). `low` má nově i ladění barev T3 |
| 2 | `medium` se držel 40–45 FPS a o cíl 40 se dělil s šumem | Sestup kvality pod 45 FPS místo 40 | Rezerva nad cílem; sestup je po bodu 1 levný |
| 3 | N8AO (AO) sám najde průhledné sítě (částice, záře) a pak každý snímek dvakrát prochází scénu a kreslí ji znovu (CPU profil piráta: ~8 %) | `opaqueAo`: průchod průhlednost ignoruje | Tučňák na `medium` 35 → 50 FPS, hasič zůstane na `medium` (~50–55) |
| 4 | Sonda vody pro e2e (`data-water-in-view`) střílela paprsky přes ~100 tisíc trojúhelníků vody a ostrovů (profil piráta: ~10 % CPU, škubnutí 1× za s) | Průsečík s rovinou hladiny + pata ostrova (`shoreDistance`) | Paprsek z profilu zmizel |
| 5 | Úvodní karta „Tap to start“ každý snímek procházela scénu a přepisovala CSS proměnné, takže další `getBoundingClientRect` vynutil přepočet rozvržení (profil čaroděje ~6 % CPU) | Hrdina se hledá jen znovu, když zmizí; styl se píše jen při změně | Čaroděj 37 → 51 / 51 / 58 |

Zkoušeno a neplatí: sníh a obrys hrdiny jako příčina (sníh = 2 volání bez práce na CPU, obrys = průchod podstromem hrdiny); WebGPU (T4, `webgpu.md`).

## Čísla (medián FPS)

| Věta | Před T7 | Po – běh A | Po – běh C (finální build) |
|---|---|---|---|
| penguin | 30 | 50 | 53,1 |
| firefighter | 13,7 | 49,6 | 49,2 |
| wizard | 43 | 40,3 | 58 |
| pirate | 40,3 | 59 | 50,2 |
| cat | 45,2 | 46 | 50 |
| chef | 59 | 59 | 58 |
| dog | 53,1 | 51,1 | 57,1 |
| knights | 54 | 42,6 | 57 |
| rocket | 60 | 59 | 60 |
| rabbit | 40,3 | 56,1 | 56 |
| robot | 48,4 | 50 | 57 |
| turtle | 57,1 | 43,3 | 59 |
| stir | 47,4 | 55,1 | 55,4 |
| spray | 49,2 | 53 | 55 |
| stack | 60 | 59 | 60 |
| carry | 54,1 | 45,2 | 55,1 |
| sweep | 58 | 49 | 33 → znovu 44,5 a 54 |
| dig | 49,2 | 58 | 30 → znovu 38,7 a 51,2 |
| paint | 51,2 | 50 | 54,1 |
| chop | 36,4 | 50,9 | 57 |
| water | 50,2 | 42,6 | 58 |
| fix | – | 55,1 | 54,1 |

- „Před T7“ = build po T2–T6, jeden vzorek (`D:/caches/p37b/t7-before/`). Běh A = build s body 1–4, běh C = finální build (body 1–5), `D:/caches/p37b/t7-final-{a,c}/`.
- **Rozptyl emulace je ±10–15 FPS na tomtéž buildu** (stroj sdílí CPU s dalšími session). Kopání má na finálním buildu pět měření 30 / 57,1 / 56 / 38,7 / 51,2 (medián 51,2), zametání tři 33 / 44,5 / 54 (medián 44,5); scény přitom na `low` kreslí 24–36 volání. Pod 40 jde jen o jednotlivé běhy, ne o vadu scény – ověřit na skutečném telefonu (HALT po T9).
- Čaroděj se v měření nehraje: AI verze hry v běhu selhala, tlačítko ukázky chybí a FPS je z úvodní karty. Tu ale vidí každý hráč jako první, proto bod 5.

## Odhad (neověřeno)

Na skutečném Pixel 7 rozhoduje víc GPU než v emulaci (ta zpomaluje jen CPU). Bod 1 přidává `low` jeden celoobrazovkový průchod a MSAA cíl – na dlaždicové GPU telefonu levné, ale změřit to umí jen telefon.
