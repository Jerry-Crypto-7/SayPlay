# P54C – nové žánry: osm nových herních smyček, každá ověřená robotem

Plán `plans/P54C-nove-zanry-2026-10-19.md` (necommitovaný). Větev `features/P54C-nove-zanry-2026-10-19` z `origin/main` `1476989e` (P52 sloučený jako #39).

## Výchozí stav (`start.json`, T1)

Píše ho `start.measure.ts`; `P54C_CHECK=1` nic nepíše a jen porovná věty a živé buňky se zapsaným souborem (důkaz „nic se nepohnulo“).

- **Replay brána** (7 souborů z plánu): 80/80 zelených.
- **Grep determinismu** (`Math.random|Date.now|performance.now` v `src/play/arcade`, `compose`, `genre`): 6 řádků, všechny v testech (měření času), žádný v kódu hry. Nový kód počet nezvedne.
- **Živé buňky:** 54.
- **P30 dev (60 vět):** klasifikátor bez čtení modelem a žánr návrhu na semínku 1 (Rapier načtený). Žádná věta nepadá do náhradního režimu ani nehází. Návrh: sběr v aréně 11, běžec 8, hod 6, plavba 6, útěk v aréně 5, úkol u stanoviště 4, po 3 střílečka, souboj, souboj v aréně, stavění, úkol v prostoru, po 2 plošinovka a rytmus, poletování 1.

## Rozhodnutí

- T1: větev nese datum jako ostatní worktree (`features/P54C-nove-zanry-2026-10-19`), ne kratší jméno z plánu; stojí přímo na `origin/main`.
