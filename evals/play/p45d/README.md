# P45D – živé 3D postavy

Hračkový pohyb pro všechny modely knihovny a doplnění chybějících modelů. Plán: P45D (interní), spec `docs/specs/2026-10-08-p45-hloubka-a-zabava.md` (interní).

## Základ – `baseline.json`

8. 10. 2026, build `0714a352` (`origin/main`, obsahuje P43 + P44E `ef0bcdea`), návrh bez režiséra, panel `evals/play/p43/panel.json`, běh `p45d-baseline` (30 volání Codexu):

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set <worktree>/evals/play/p43/panel.json --clip --draft-only --gpu --base http://127.0.0.1:3245 --run p45d-baseline
node --experimental-strip-types scripts/play-fidelity.mjs judge --clip --run p45d-baseline
P43_RUN=p45d-baseline P43_OUT=../p45d/baseline.json npx vitest run --config vitest.measure.mts evals/play/p43/visible.measure.ts
```

| | `baseline.json` |
|---|---|
| hrdina modelem | 19/23 (83 %) |
| hrdina poznaný | 9/23 (39 %) |

P43 `after-b.json` měl hrdinu modelem 20/23 nad buildem `a11e657c`; navíc dnes chybí f08 (unicorn) – příčina nezjištěná (P44C mezitím změnil výběr modelu ke slovu).

**Hrdinové panelu bez modelu (vstup pro T16):** f08 unicorn, f24 cyclops, m09 ninja cat, u08 mole.

**P45A v `origin/main`:** ne – `git log origin/main --grep "P45A"` je prázdný a `evals/play/p45/` neexistuje (8. 10. 2026). Měření nad vývojovým panelem P45A čeká na sloučení (T20).

## Třídy těl – `src/assets/catalog-motion.json`

`node scripts/p45d/motion-class.mjs` nad 929 modely: prop 412, biped 346, quadruped 56, vehicle 50, flyer 34, swimmer 31; pohyblivý díl s rolí má 14 modelů. Třídu dává nejdřív manifest hrdinů P32, pak `heroClass` nad jednoslovným id, pak poměr rozměrů; model s dveřmi je vždy prop.
