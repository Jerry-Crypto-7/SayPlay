# P45E – generování chybějících 3D modelů

Vyčleněno z P45D (úlohy T17–T19), aby karta RTX 3090 nečekala na animace. Plán: P45E (interní), spec `docs/specs/2026-10-08-p45-hloubka-a-zabava.md` (interní).

## Odkud jsou jména

Větev převzala fast-forwardem commit P45D `133167ba` (T1 základ, T2 třída těla, T3 soudce pohybu, T16 výběr jmen) – stejné commity jako na `features/P45D-zive-postavy-2026-10-08`, při slučování nekonfliktí.

- `evals/play/p45d/missing.json` – 118 jmen, která lidé píšou a knihovna nekreslí (`scripts/p37d/missing-nouns.mjs`, 8. 10. 2026).
- `evals/play/p45d/gen-nouns.json` – 48 z nich vybraných pro generátor (`scripts/p45d/pick-nouns.mjs`): 2 hrdinové panelu P43 (cyclops, mole), 29 podle počtu vět, 17 záměn soudce P43; 13 plochých nebo drobných.
- Třída těla pro šablonu zadání: `scripts/p45d/motion-class.mjs` (`quadruped`, `biped`, `flyer`, `swimmer`, `vehicle`, `prop`; `flat` = ploché nebo drobné).

P45E tyhle soubory jen čte; `src/assets/catalog-motion.json` se po povýšení regeneruje `node scripts/p45d/motion-class.mjs`.

## Okno stroje

Stroj volný 8. 10. 2026 večer do **9. 10. 2026 08:00**. Po **9. 10. 2026 07:30** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší a zbytek se zapíše do `gen-round.md`. Karta je sdílená s P45B (lokální gpt-oss-20b) – každý běh na ní jde přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`.
