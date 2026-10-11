# P45G – rekvizity pro prostředí, která knihovna neumí

Plán: P45G (interní). Větev převzala fast-forwardem lokální `features/P45F-dogenerovani-modelu-2026-10-09` (`53f24c81`) – slučuje se **po P45F**, ten po P45E.

## Odkud jsou jména

- **8 nezpracovaných jmen P45F** (dávka 6 nespuštěná kvůli oknu): rhino, singer, space station, swing, tablet, tape, tea, torpedo. Ruční znak v `ops/gen3d/features.toml` mají z P45F, seznam v `D:/caches/p45f/round6/list.json`.
- **Prostředí** z `evals/play/p45d/missing.json` → `settings`: 85 prostředí, která porotci píšou a knihovna nemá čím nakreslit, dohromady 101 vět (frozen lake a highway po 4, supermarket a underwater po 3, birthday party, deep sea, haunted mansion, mall, tavern, winter po 2, zbytek po 1). Pro každé prostředí 2–4 typické rekvizity, podle kterých ho hráč pozná (supermarket: nákupní vozík, regál, pokladna).
- **Proč prostředí, ne zbytek jmen:** zbylých 80 chybějících předmětů pokrývá jen 54 vět a nese šum („mar“, „electricity bill“).
- Mimo: kód generátoru, `src/play/**`, `src/components/**`, placená API, zapečetěné sady.

## Okno a strop

- Karta RTX 3090 sdílená s P45B, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Cache `D:/claude/_gen3d-cache-p45g`, záznam dávek `D:/caches/p45g/round<n>/`.
- Po **11. 10. 2026 18:45** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`. Souhrn hotový nejpozději v 19:15.
- Codex na předplatné (předkontrola + slepý soud v prázdném adresáři, jen `sheet.png`): strop celého P45G **400 volání**. Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí. Výstupy soudce nikdy do trénovacích dat.
- Povýšení nesmí změnit výsledek testů v `src/play`; když zčervenají, jméno jde ven přes `promote-batch.mjs --drop` a zapíše se jako zjištění.
