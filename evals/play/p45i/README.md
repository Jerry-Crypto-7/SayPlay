# P45I – modely přes noc

Plán: P45I (interní). Větev převzala fast-forwardem lokální `features/P45G-modely-prostredi-2026-10-11` (`50796f7d`) – slučuje se **po P45G**, ten po P45F a P45E. Souběžně běží P45H (scenérie podle prostředí v `src/play`); po sloučení P45I jen znovu pustí `scripts/p45h/build-setting-kits.mjs`.

## Odkud jsou jména

1. **8 modelů, které soudce v P45G přijal, ale nepovýšily se** – dog kennel, dog bowl, cow skull, car jack, luggage cart, wizard tower, dinosaur skeleton, rooftop water tank. Manifest P32 jim podle slova ve jménu dal třídu zvířete, vozidla nebo postavy a pin počtu v `src/play` zčervenal. Po opravě manifestu (T2) se povýší z mezipaměti `D:/claude/_gen3d-cache-p45g` bez nového generování.
2. **Dávky 15–16 P45G** (19 jmen) – nespuštěné kvůli oknu, znak v `ops/gen3d/features.toml` mají (`D:/caches/p45g/round15/list.json.held`, `round16/list.json`).
3. **Opakování neprošlých P45G** s novým seedem: 5 s `normalize: LOD1 cannot be made lighter than LOD0`, 5 s `inconsistent face winding`, 13 se správným jménem, ale obrázkem označeným jako rozbitý; 3 se synonymem jen pro předkontrolu (car wreck → wrecked car, dingo → dog, tooth model → tooth) – slepý soud dál soudí původní jméno.
4. **Druhá rekvizita** pro 33 prostředí, která mají po P45G jednu, a **první dvě** pro 11 prostředí bez žádné (`evals/play/p45g/kit-nouns.json`, `evals/play/p45d/missing.json` → `settings`).
5. **Zbylé chybějící předměty** z `evals/play/p45d/missing.json` podle počtu vět, bez šumu (nekreslitelná jména se vyřadí s důvodem níže).

Mimo: `src/play/**` a `src/components/**` (P45H), placená API, zapečetěné sady.

## Okno a strop

- Karta RTX 3090, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Mezipaměť `D:/claude/_gen3d-cache-p45i` (modely P45G z `D:/claude/_gen3d-cache-p45g` se smí číst), záznam dávek `D:/caches/p45i/round<n>/`.
- Po **12. 10. 2026 07:00** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`. Souhrn hotový nejpozději v 07:30.
- Codex na předplatné (předkontrola + slepý soud v prázdném adresáři, jen `sheet.png`): strop celého P45I **900 volání**. Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí. Výstupy soudce nikdy do trénovacích dat.
- Povýšení nesmí změnit výsledek testů v `src/play`; když zčervenají, jméno jde ven přes `promote-batch.mjs --drop` a zapíše se jako zjištění.
- Když P45H zrovna buildí nebo pouští e2e, sady P45I se nespouští (časové testy pod zátěží padají).
