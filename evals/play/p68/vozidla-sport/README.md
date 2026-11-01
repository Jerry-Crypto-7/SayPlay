# P68V – vozidla a sport (`stunt`, `minigolf`)

Pruh P68-V staví dvě nové hry ve vlastních souborech: krátký kaskadérský závod `stunt` a jednu jamku minigolfu
`minigolf`. Sdílené soubory vlastní P68-I; co pruh od nich potřebuje, je v `integration.md`.

## Kostra

Kostra P68-I T1 je v `origin/main` `15c81e6a` („P68 scaffold five games and freeze shared contracts“, #61); větev
pruhu ji sloučila 1. 11. 2026 (čekání smyčkou á 10 min, ~2 h). Jména souborů kostry = jména z plánu:

| část | `stunt` | `minigolf` |
|---|---|---|
| modul žánru | `src/play/genre/stunt.ts` (`stagedGenre`) | `src/play/genre/minigolf.ts` (`stagedGenre`) |
| jádro | `src/play/arcade/pieces/stunt.ts` (`stuntControl`, `stuntTrack` = `stunt_track`, `STUNT_RULES`) | `src/play/arcade/pieces/minigolf.ts` (`minigolfControl`, `minigolfCourse` = `minigolf_course`, `MINIGOLF_RULES`) |
| robot | `src/play/arcade/pieces/stunt-bot.ts` (`stunt_bot`) | `src/play/arcade/pieces/minigolf-bot.ts` (`minigolf_bot`) |
| scéna | `src/components/play/arcade/genres/stunt/StuntScene.tsx` | `src/components/play/arcade/genres/minigolf/MinigolfScene.tsx` |
| e2e | `e2e/play-stunt.spec.ts` (`test.skip`) | `e2e/play-minigolf.spec.ts` (`test.skip`) |
| Stage / vstup | `scene: 'stunt'`, `input: 'steer'` | `scene: 'minigolf'`, `input: 'throw-rig'` |

- Zmrazená rozhraní: `src/play/genre/p68-contract.ts` – `P68_VIEWS.stunt = ['chase']`, `minigolf = ['shoulder', 'top']`,
  `STUNT_DEBRIS_MAX = 24` (plán pruhu drží `debrisMax` 8, pod stropem), `P68_MAX_TICKS = 5400`. Herní aserce
  `evals/play/p68/assertions.json`. Brána aktivace: `ROUTE_PENDING` v klasifikátoru, `DIRECTOR_PENDING` u režiséra.
- `CONTROL_PARAMS.stunt` / `.minigolf` = `z.object({}).strict()` (zmrazené prázdné) – parametry hry jdou přes modul žánru.
- **Playwright:** kostra dopsala `play-stunt` a `play-minigolf` do `testMatch` `pixel7-touch` i `iphone-touch` –
  `playwright.p68v.config.ts` není potřeba.
- **Šev pro scénu:** `ArcadeStage.tsx` montuje `StuntScene` / `MinigolfScene` podle `stage.scene` (props `WorldProps`).
- **Šev pro dotyk:** registr `genres/touch-registry.ts` (`GENRE_TOUCH`) montuje adaptér jen hrám se vstupem `genre`
  (`railfps`, `drawsave`). `stunt` (`steer`) a `minigolf` (`throw-rig`) dostanou dotykový vstup, který `ArcadeStage`
  pro tyto vstupy už má. **Výchozí postup** pro vlastní adaptér (`StuntTouch`, `MinigolfTouch`): scéna ho vykreslí sama
  jako DOM přes `Html` / portál do kontejneru plátna; prosba o čistou montáž (registr i pro vstupy `steer` /
  `throw-rig`, nebo vstup `genre` pro tyto hry) je v `integration.md`.
- **Směrování po kostře:** snímek `route-before.json` na `15c81e6a` dává stejné rozdělení 200 vět jako `688d989d`
  před kostrou (brána aktivace drží).

## Hlídače

- **Vlastnictví** – `owned-paths.mjs`: `git diff --name-only origin/main...HEAD | node evals/play/p68/vozidla-sport/owned-paths.mjs`
  vrátí 0 jen když diff obsahuje výhradně soubory pruhu (moduly `src/play/genre/{stunt,minigolf}.ts`, soubory
  `stunt*` / `minigolf*` přímo v `src/play/arcade/pieces/` a jejich testy, `src/components/play/arcade/genres/{stunt,minigolf}/**`,
  `e2e/play-{stunt,minigolf}.spec.ts`, `e2e/fixtures/p68-{stunt,minigolf}-spec.json`, `evals/play/p68/vozidla-sport/**`).
  Jinak vypíše cizí cesty a vrátí 1. Test: `__tests__/owned-paths.test.ts`.
- **Směrování** – `route-before.json` = `classifyGenre(věta, null).ranked[0]` (žánr a režim rychlé hry, bez modelu)
  na všech 200 větách `evals/play/p30/test-200.json`. `__tests__/routing-guard.test.ts` spočítá totéž na větvi
  a selže při jakékoli změně. Přepočet: `node evals/play/p68/vozidla-sport/route-snapshot.mjs`. Když `origin/main`
  směrování legitimně změní (P68-I zapojí hru), snímek se přepočítá z čistého checkoutu `origin/main`:
  `node evals/play/p68/vozidla-sport/route-snapshot.mjs --root <checkout origin/main>` – nikdy z větve pruhu.
- **Solver** – `__tests__/solver-untouched.test.ts`: `git diff --quiet <merge-base HEAD origin/main> -- src/play/arcade/physics
  src/play/arcade/contract.ts src/play/arcade/kernel.ts` vrátí 0. Srovnává se s místem odbočení, ne s hrotem
  `origin/main`: když P68-I sám změní `contract.ts`, není to změna pruhu a test nemá zčervenat. Kontrolní případ
  (rodič posledního commitu se `step.ts`) dokazuje, že tentýž příkaz změnu vidí.
- **Dev věty** – `dev.json`, 10 na `stunt` a 10 na `minigolf`. `__tests__/dev-sentences.test.ts` hlídá, že žádná
  není v `p30/test-200.json` ani v jiné sadě vět pod `evals/play` (normalizovaný text). Ladí se jen na nich.

## Inventura modelů

`node evals/play/p68/vozidla-sport/model-inventory.mjs` na `688d989d` (= `origin/main` bez kostry; kostra modely nemění).
`nalezeno` = tag katalogu (`modelOf`), `nearest` = jen nejbližší model (`sceneModelOf`), `chybí` = scéna kreslí procedurálně.

| věc | `modelOf` | `sceneModelOf` | stav |
|---|---|---|---|
| car | race-car | race-car | nalezeno |
| sports car | race-car | race-car | nalezeno |
| police car | gen3d-police-car | gen3d-police-car | nalezeno |
| monster truck | gen3d-monster-truck | gen3d-monster-truck | nalezeno |
| truck | cc0-garbage-truck | cc0-garbage-truck | nalezeno |
| bus | cc0-bus | cc0-bus | nalezeno |
| motorbike / motorcycle | gen3d-motorbike | gen3d-motorbike | nalezeno |
| scooter | gen3d-scooter | gen3d-scooter | nalezeno |
| tractor | cc0-tractor | cc0-tractor | nalezeno |
| buggy | gen3d-ride | gen3d-ride | nalezeno |
| ramp | gen3d-ramp | gen3d-ramp | nalezeno |
| crate / box | crate | crate | nalezeno |
| barrel | cc0-barrel | cc0-barrel | nalezeno |
| tire | tire-barrier | tire-barrier | nalezeno |
| cone | cone | cone | nalezeno |
| fence | iron-gate | iron-gate | nalezeno (brána místo plotu) |
| hay bale | cc0-hay-bale | cc0-hay-bale | nalezeno |
| trash can | cc0-trash-can | cc0-trash-can | nalezeno |
| watermelon | gen3d-suika | gen3d-suika | nalezeno |
| bridge | wooden-bridge | wooden-bridge | nalezeno |
| golf ball | gen3d-golf-ball | gen3d-golf-ball | nalezeno |
| ball | ball | ball | nalezeno |
| hole | – | – | **chybí** → procedurální jamka (válec + okraj) ve scéně |
| flag | finish-flag | finish-flag | nalezeno |
| windmill | gen3d-windmill | gen3d-windmill | nalezeno |
| golf club | gen3d-golf | gen3d-golf | nalezeno |
| bumper | tire-barrier | tire-barrier | nalezeno |
| log | cc0-wood-log | cc0-wood-log | nalezeno |
| pumpkin | cc0-pumpkin | cc0-pumpkin | nalezeno |
| coffin | gen3d-coffin | gen3d-coffin | nalezeno |
| rocket | rocket | rocket | nalezeno |
| castle | gen3d-kingdom | gen3d-kingdom | nalezeno |
| penguin | penguin | penguin | nalezeno |

Rampa má model (`gen3d-ramp`); jeho tvar se v T4 ověří proti skokové hraně. Chybějící jamka a případně dráha
minigolfu se kreslí procedurálně; kandidát z CC0 kitu je v `integration.md`.
