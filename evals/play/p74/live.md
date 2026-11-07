# P74 T2 – zkušební produkce na emulovaných telefonech (7. 11. 2026)

Nasazení `dpl_HTZBbRdP4akLwR2zvwwjR74RNYRw`, strom `6350ab72` (`main` 2554d28c), kniha `sayplay-trial`. Skript `scripts/play/p74-live.mjs`, surová data `ai.json` a `phones.json`, snímky `shots/`.

Telefony: iPhone 15 (Playwright WebKit, dotyk) a Pixel 7 (Chromium, dotyk, CPU 4×, `--disable-features=OpenXR`). Oba běží na Windows PC – WebKit tady není Safari na iPhonu, výsledek iPhonu je emulace, ne skutečné zařízení.

## Pět nových vět (AI verze)

| věta | rychlá hra | AI verze |
|---|---|---|
| a hamster in a teacup sails across a flooded kitchen collecting cherries | 1,8 s | nedorazila – `MODEL_UNAVAILABLE` |
| a lighthouse cat herds glowing fireflies into jars before dawn | 2,0 s | nedorazila – `MODEL_UNAVAILABLE` |
| an astronaut snail races across a moon made of cheese | 2,1 s | nedorazila – `MODEL_UNAVAILABLE` |
| a grumpy cactus bounces tumbleweeds away from its desert flower | 1,8 s | nedorazila – `MODEL_UNAVAILABLE` |
| a tiny robot waters seedlings on a windy balcony while pigeons try to eat them | 1,4 s | nedorazila – `MODEL_UNAVAILABLE` |

- Rychlá hra 5/5, medián 1,8 s od odeslání věty do odpovědi serveru (měřeno z PC, ne prohlížečem).
- AI verze 0/5, `reached:false`: klíč režiséra je z doby tunelu a model ho nebere (plán T1). Stránka to hráči říká hláškou „Couldn't make the full-detail version right now…“.
- Cena z knihy `sayplay-trial`: nečitelná z běhu – kniha je v Upstash a klíče `KV_*` jsou ve Vercelu citlivé. Odhad (inference): 0 USD, žádné volání modelu neprošlo.
- Prvních 5 pokusů o tytéž věty skončilo `503 DISABLED` – viz R1 níž.

## Každý živý žánr na obou telefonech

Kontrola na řádek: hra se načte, snímek uprostřed hry, robot `playWitness()` vyhraje, výhra „rukou“ pošle výzvu a druhý prohlížeč ji otevře (`dare`), jinak holý odkaz (`link`). Funkčně **56/56 prošlo**. Sloupce iPhone/Pixel jsou verdikt očí na snímku. `stunt` je vypnutý přepínačem `ROUTE_PENDING`, není v tabulce.

| žánr | zdroj | iPhone | Pixel | poznámka |
|---|---|---|---|---|
| runner | věta | prošlo | prošlo | iPhone 1× chyba stránky `null is not an object (evaluating 'i.x')` (R5) |
| platformer | věta | prošlo | prošlo | |
| arena | věta | prošlo | prošlo | |
| voyage | věta | prošlo | prošlo | přistávání: větev ještě mimo záběr |
| quest | věta | prošlo | prošlo | |
| shooter | věta | **selhalo** | prošlo | iPhone po ťuku bez scény (R2); výhra rukou nemíří, výzva jen jako odkaz |
| throw | věta | prošlo | prošlo | |
| timing | věta | **selhalo** | prošlo | iPhone po ťuku bez scény (R2) |
| rhythm | věta | **selhalo** | prošlo | iPhone po ťuku bez scény (R2) |
| duel | věta | **selhalo** | prošlo | iPhone po ťuku bez scény (R2) |
| flap | věta | **selhalo** | prošlo | iPhone po ťuku bez scény (R2) |
| catch | věta | prošlo | prošlo | |
| whack | věta | prošlo | prošlo | |
| defense | věta | prošlo | prošlo | |
| slice | věta | prošlo | prošlo | |
| hop | věta | prošlo | prošlo | |
| crowd | věta | prošlo | prošlo | |
| merge | věta | prošlo | prošlo | |
| push | věta | prošlo | prošlo | |
| survivor | věta | prošlo | prošlo | |
| hole | věta | prošlo | prošlo | |
| steal | ruční spec | prošlo | prošlo | rychlá verze žánr z věty nedá (P66 trasa) |
| sort | věta | prošlo | prošlo | |
| arrows | ruční spec | prošlo | prošlo | rychlá verze žánr z věty nedá (P66 trasa) |
| minigolf | věta | **selhalo** | **selhalo** | iPhone: jen mlha, hřiště není vidět; Pixel: hřiště malé na dolním okraji v mlze (R3) |
| railfps | věta | prošlo | prošlo | |
| buildshift | věta | prošlo | prošlo | |
| drawsave | věta | prošlo | prošlo | |

„Prošlo“ na iPhonu platí pro snímek ve 2,5 s. Po ~3 s hry přepne hlídač kvality iPhone z `medium` na `low` a scéna zmizí u **každé** hry (ověřeno na duel, arena, catch, sort, minigolf) – R2. Načtení stránky do prvního snímku: medián 1,4 s iPhone, 2,6 s Pixel (z PC, informativně).

## Nálezy (úlohy R v plánu)

- **R1 – produkce občas odmítne tvorbu hry `503 DISABLED`** („this part of PLAY is switched off right now“). 9 z 66 POST mezi 12:40 a 13:05, ve dvou shlucích (5 a 4 za sebou); sonda 12× po 4 s hned potom 12/12 v pořádku. Proměnná `WORLDSMITH_CONTROL_FILE` není nastavená, takže vypínač čte klíč `sayplay-trial:control` z Upstash s limitem 200 ms (`DEFAULT_CONTROL_TIMEOUT_MS`); selhané čtení = „rozbitý vypínač“ = placené dveře zavřené a selhání se sdílí 1 s oknem. Hypotéza: čtení klíče občas přesáhne 200 ms.
- **R2 – iPhone (WebKit): po přepnutí kvality na `low` se 3D scéna přestane kreslit.** Plátno 589×988 → 393×659, počet kreslicích volání klesne asi na polovinu, vidět je jen barva pozadí a štítky (`shots/r2-duel-iphone-medium.jpg` → `r2-duel-iphone-low.jpg`). Pixel zůstává na `medium` a kreslí.
- **R3 – minigolf: hřiště na startu skoro není vidět** – na iPhonu ani na `medium`, na Pixelu malé v mlze na dolním okraji (`shots/minigolf-*.jpg`).
- **R4 – hláška „Couldn't make the full-detail version right now. Keep playing the quick…“ přetéká přes pravý okraj obrazovky** na obou telefonech (text i rámeček uříznuté, např. `shots/catch-pixel.jpg`).
- **R5 – chyba stránky na iPhonu** `null is not an object (evaluating 'i.x')`, 1× z 28 (runner, první načtení).
