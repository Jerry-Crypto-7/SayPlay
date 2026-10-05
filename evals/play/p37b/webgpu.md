# P37B T4 – WebGPU: zavést, nebo ne? (4. 10. 2026)

**Rozhodnutí: do freeze (4. 11.) WebGPU nezavádět.** Arkáda zůstává na `WebGLRenderer` (WebGL2). Pokus nepřinesl měřitelné zrychlení a rozbil polovinu vzhledu, který porotce vidí. Kód pokusu žije jen ve větvi `exp/p37b-webgpu` (`175ba13d`).

## Co se zkoušelo

- three 0.185.1 `WebGPURenderer` z `three/webgpu` jako asynchronní `gl` plátna v `@react-three/fiber` 9.7 (`renderer.init()` před prvním snímkem). Bez WebGPU v prohlížeči renderer sám spadne na backend WebGL2 – ověřeno.
- Zapíná ho build s `NEXT_PUBLIC_P37B_WEBGPU=1`. Skládač `postprocessing` (AO, SMAA, bloom, ACES, ladění barev) umí jen `WebGLRenderer`, takže v pokusu je vypnutý.
- Měření: 4 hry (wizard v aréně, turtle na plošinách, cat v aréně s medvědem, runner), sonda v systémovém Edge (Chromium s WebGPU přes D3D12), desktop 1280×800 a Pixel 7 (emulace, CPU 4×), 10 s hraní, medián FPS po sekundách. Totéž proti buildu bez pokusu.

## Čísla

| Hra | Desktop WebGPU | Desktop WebGL | Pixel 7 WebGPU | Pixel 7 WebGL |
|---|---|---|---|---|
| wizard (aréna, hrad) | 56,6 | 54,6 | 35,2 | 23,6 |
| turtle (plošiny, vesmír) | 57,1 | 56,8 | 50,9 | 54,1 |
| cat (aréna, sníh) | 56,7 | 56,9 | 31,4 | 38,3 |
| runner (les) | 56,7 | 56,6 | 26,2 | 50,8 |

- Desktop drží obojí u stropu obnovovací frekvence – rozdíl žádný.
- Telefon: WebGPU horší u 3 ze 4 her, **přestože kreslí méně** (bez skládače, oblohy a obrysu). Lepší jen wizard – a tam WebGL vzorek padá na 5,9 FPS při sestupu kvality, který je vadou WebGL cesty, ne výhodou WebGPU (řeší T7).
- Do prvního snímku: desktop 0,8–1,7 s (WebGPU) proti 0,7–2,1 s (WebGL), telefon 3,9–4,6 s proti 3,1–4,4 s. `renderer.init()` a překlad pipeline start spíš zdrží.
- Jeden vzorek na hru: rozptyl emulace je ±10 FPS (viz T3: wizard 40,6–57 na tomtéž buildu). Čísla nestačí na tvrzení, že WebGPU je pomalejší; stačí na to, že **rychlejší není**.

## Co se rozbilo

- **Obloha:** `ShaderMaterial` s vlastním GLSL (`StyleRig` – gradient oblohy se sluncem) `NodeBuilder` odmítne – obloha je plochá barva nebo jen mlha.
- **Obrys hrdiny, sníh na vrcholcích, voda:** stavějí na `onBeforeCompile` / GLSL (`InkOutline`, `snowcap`, `water`); node materiály je neznají – obrys zmizí.
- **Celý skládač:** N8AO, SMAA, bloom, ACES i ladění barev P37B T3 by se musely přepsat do TSL postprocessingu three (`three/tsl`), knihovna `postprocessing` ani `n8ao` WebGPU neumí.
- **Chyby validace WebGPU** v každé hře: zničená textura stínu (`ShadowDepthTexture`) použitá v submitu, chybějící vertex buffer (slot 1) u `MeshStandardMaterial` – část snímků se nezakreslí.
- **Měřicí řetězec:** Chromium přibalený k Playwrightu WebGPU zařízení nevytvoří (`dxil.dll` chybí, Dawn D3D12 `Windows Error 87`) a tiše jede na WebGL2. E2e, klipy i FPS by musely přejít na kanál Edge/Chrome – jinak by testovaly jiný renderer než porotce.

## Proč ne do freeze

- Přínos: na desktopu nula, na telefonu nedoložený.
- Cena: přepsat oblohu, obrys, sníh, vodu a celý skládač do TSL, opravit stíny a vertex buffery a přestavět měřicí řetězec – to je víc než zbývající týdny do 4. 11. a riziko, že porotci se zobrazí horší obraz.
- **Odhad (neověřeno):** WebGPU na telefonech porotců – Chrome na Androidu 12+ ho má, Safari od iOS 26 také; starší telefony by stejně jely na WebGL2 backendu, tedy na cestě, kterou jsme tu neměřili jako výhodnou.

## Kdy to zkusit znovu

Po odevzdání, a jen když: (1) TSL náhrady oblohy, obrysu a skládače existují a projdou slepým soudem vzhledu, (2) měření na skutečném telefonu (ne emulaci) ukáže ≥ 10 FPS zisk na nejpomalejší scéně, (3) e2e běží v kanálu prohlížeče s funkčním WebGPU.
