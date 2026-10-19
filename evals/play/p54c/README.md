# P54C – nové žánry: osm nových herních smyček, každá ověřená robotem

Plán `plans/P54C-nove-zanry-2026-10-19.md` (necommitovaný). Větev `features/P54C-nove-zanry-2026-10-19` z `origin/main` `1476989e` (P52 sloučený jako #39).

## Výchozí stav (`start.json`, T1)

Píše ho `start.measure.ts`; `P54C_CHECK=1` nic nepíše a jen porovná věty a živé buňky se zapsaným souborem (důkaz „nic se nepohnulo“).

- **Replay brána** (7 souborů z plánu): 80/80 zelených.
- **Grep determinismu** (`Math.random|Date.now|performance.now` v `src/play/arcade`, `compose`, `genre`): 6 řádků, všechny v testech (měření času), žádný v kódu hry. Nový kód počet nezvedne.
- **Živé buňky:** 54.
- **P30 dev (60 vět):** klasifikátor bez čtení modelem a žánr návrhu na semínku 1 (Rapier načtený). Žádná věta nepadá do náhradního režimu ani nehází. Návrh: sběr v aréně 11, běžec 8, hod 6, plavba 6, útěk v aréně 5, úkol u stanoviště 4, po 3 střílečka, souboj, souboj v aréně, stavění, úkol v prostoru, po 2 plošinovka a rytmus, poletování 1.

## Sady (T2)

- **`dev.json`** – 80 vět napsaných 19. 10. před prvním během: 8 na každý z osmi nových žánrů (`expect` = `<žánr>.default`) a 16 pastí (`family: "trap"`), které používají lákavé slovo nového žánru v jiném smyslu („the police try to catch the thief“, „chop wood and build a cabin“, „merge into traffic and race“). Štítek pasti je žánr, který autor myslel; brána T13 ale porovnává pasti s `baseline.json`, ne se štítkem. Ladí se jen na téhle sadě.
- **`holdout.json`** – 80 vět, které napsal nezávislý subagent bez přístupu ke kódu, plánům a sadám. Dostal jen osm jmen a jednovětých popisů žánrů, tvar záznamu a pokyn psát přirozené věty hráčů 13+: 60 cílových (8 na catch, whack, defense, slice, 7 na hop, crowd, merge, push) a 20 rušivých (`genre: null`). Soubor zapsal sám a vrátil jen otisk a počty. **SHA-256 nad LF bajty: `c3d545c53a59d8569f264466818bf3172fbba49a9914928d1efd7b6e650eca68`** (hlídá `__tests__/sets.test.ts`). Do T16 ho čte jen test otisku, tvaru a kolizí (do výstupu jdou jen id).
- Kolize: h03 se shodovala s dev větou f03, protože brief subagentovi ji uváděl jako příklad. Změnila se dev věta (f03 teď „stop the skeletons before they break into the barn“), holdout zůstal; h03 tedy není nezávislá věta a T16 ji tak čte.
- Žádná věta dev ani holdoutu se po `normalizeSentence` neshoduje s jinou sadou `evals/play/**` (soubory do 1 MB) ani mezi sebou.

## Výchozí stav dev sady (`baseline.json`, po T2)

Píše ho `P54C_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p54c/classify.measure.ts` (klasifikátor bez čtení modelem + žánr návrhu na semínku 1, Rapier načtený).

| Žánr | Kam dnes padá 8 vět (žánr návrhu) |
|---|---|
| catch | sběr v aréně 6, úkol v prostoru 1, běžec 1 |
| whack | úkol v prostoru 5, sběr v aréně 2, útěk 1 |
| defense | souboj v aréně 4, sběr v aréně 2, souboj 1, střílečka 1 |
| slice | plavba 4, souboj v aréně 2, sběr v aréně 1, hod 1 |
| hop | běžec 4, plošinovka 3, plavba 1 |
| crowd | běžec 3, sběr v aréně 2, úkol v prostoru 1, souboj 1, úkol u stanoviště 1 |
| merge | úkol u stanoviště 6, sběr v aréně 1, hod 1 |
| push | sběr v aréně 5, plavba 1, souboj 1, plošinovka 1 |

- Žádná věta nehází a žádná nepadá do náhradního režimu. Pasti: 8/16 hrají žánr, který autor myslel; zbylých 8 hraje jiný starý žánr (např. „police try to catch the thief“ běžec místo útěku) – T13 je drží beze změny proti tomuhle souboru.

## T3 – míčové věty na živé cestě (`ball-path.json`)

- Šest vět (tři ze sondy 19. 10., tři míčové z `p41/sentences.json`) přes `POST /api/play/games` na `next start`: **všech šest hraje míč**, ověření serveru `bot_wins`, `idle_loses`, `replay_equal` zelené. Chyba „No playable assembly: assembled.ball“ byla jen v sondě, která stavěla návrh bez `loadRapier()`. Server Rapier čeká vždy (`games/route.ts`, `director/index.ts`), oprava kódu hry není potřeba.
- `src/play/compose/__tests__/ball-assembly-path.test.ts` to drží: bez Rapieru návrh nahlas odmítne (nikdy tiše nehraje jinou hru), s Rapierem všech šest vět dá `control: ball`.
- **`e2e/play-ball.spec.ts` byl na `main` červený** (4/4) a nesouvisel s větami: od P51 balí ovládání míče `pacing_control`, takže pomocník `replayState` (`e2e/play-native-input.ts`) nenačetl Rapier, a živá hra má před výkopem hráče na hřišti i míč soupeře z finále, na který test mířil. Pomocník teď Rapier čeká vždy a test bere posledně spawnutý míč; 4/4 zelené.
- Mimo T3: hláška poctivosti „The obstacles isn't here yet“ má špatný tvar slovesa pro množné číslo (copy P44, ne žánry).

## T4 – kostra osmi žánrů a ovládání pruhů

- **Osm žánrů je zapsaných, ale nehraje.** `catch`, `whack`, `defense`, `slice`, `hop`, `crowd`, `merge`, `push` (režim `default`) mají varianty schématu, `FOE_DOES` a `COUNT_PARAMS`; `compile` hází „not live“ a buňky v `compose/allowed.ts` mají stav `staged`.
- **Nový stav `staged` místo plánovaného `fallback`.** Kostra s `fallback` by u vět bez jasného slovesa stála v pořadí před běžcem a `compose()` zkouší celé pořadí – spadla by. `classifyGenre` žánry `staged` z pořadí vyřadí; úloha, která žánr pouští živě, přepne jeho buňku na `ready`.
- **Kusy os záměru** (`intent/contract.ts`) mají vlastní seznamy, ne hlavní `MOVES`/`ACTIONS`/`OBJECTIVES` – ty typují slovník sloves (kotvy a přestavba) a `action-cue/cues.ts` (soubor P54A):
  - `GENRE_MOVES`: `lanes`, `hop`, `crowd`, `drop`;
  - `GENRE_ACTIONS`: `whack`, `slice`, `merge`, `push`;
  - `GENRE_OBJECTIVES`: `defend`.
- **Ovládání** `lanes`, `hop`, `crowd`, `merge`, `push` je v `CONTROLS`, `CAPABILITIES`, `STAGES` a `CONTROL_PARAMS`. Čtení modelem nabízí jen `READ_CONTROLS` (všechna kromě `STAGED_CONTROLS` ve `spec.ts`), takže dotaz na model se nemění; úloha, která ovládání pustí živě, ho z `STAGED_CONTROLS` vyjme.
- **Pruhy** (`src/play/arcade/pieces/lanes.ts`): osa −1000..1000 → pruh 0–4 po pásmech šířky 400, šipky o pruh, `TAP` ťuk a `HOLD` držení do těla hráče (`aux0` pruh, `aux1` ťuk/tiky držení). Scéna-kostra `src/components/play/arcade/genres/lanes/LaneScene.tsx` kreslí pět pásů a kvádry těl; `lanes-input.ts` dělí plátno na pět svislých pásů (prst = ťuk a držení v pruhu, tah drží osu), šipky/A-D posunou, mezerník ťuk a držení. V `ArcadeStage.tsx` 4 řádky: import, dvouřádková větev scény (formátovač ternár nezalomí jinak) a hák vstupu. Scény `hop`, `crowd`, `merge`, `push` přidají úlohy svých žánrů.
- **Schéma režiséra se nemění.** Varianta žánru vzniká jen z režimů `ready` (`readyModes` v `director/answer-schema.ts`), kostry žádný nemají, takže JSON Schema odpovědi i jeho test zůstaly beze změny. Přepíše se vědomě, až první žánr pustí režim `ready` (T5–T8).
- **Nic se nepohnulo:** `P54C_CHECK=1 … start.measure.ts` (věty P30 dev a živé buňky = `start.json`), replay brána, `difficulty.test.ts` (buňky `staged` se neměří; golden `freeze.ts` přeskočí žánry mimo `parameter-bounds.json`), `lanes.test.ts`.
- Modely pro P54B: `models-wanted.md`.

## Rozhodnutí

- T1: větev nese datum jako ostatní worktree (`features/P54C-nove-zanry-2026-10-19`), ne kratší jméno z plánu; stojí přímo na `origin/main`.
