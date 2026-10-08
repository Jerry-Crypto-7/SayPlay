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

## Je postava živá – `alive-baseline.json`

8. 10. 2026, týž build `0714a352` (žádný hračkový pohyb), panel `evals/play/p43/panel.json`, 23 vět s hrdinou, 23 volání Codexu:

```
node scripts/p45d/alive-clip.mjs --run p45d-alive-baseline --gpu --out evals/play/p45d/alive-baseline.json
```

| | `alive-baseline.json` |
|---|---|
| živá (`alive`) | 17/23 (74 %) |
| poznaná (`likeNoun`) | 9/23 (39 %) |
| okno začíná pohybem hrdiny | 21/23 (91 %) |

Ne: unicorn (soudce viděl auto), baby dragon, phoenix, broom, grandma a hedgehog (ti dva stáli).

**Zjištění – měřidlo je zatím shovívavé.** 74 % vychází už bez hračkového pohybu, nad cílem 70 %. Část je skutečná (riggované postavy hrají klipy chůze a útoku – mole a cyclops jsou riggovaný farmář), ale list zlaté rybky (d12) ukazuje skoro nehybné tělo, které jen pluje, a soudce ho přesto uznal jako „swimming“. Jestli otázka měří pohyb těla, rozhodne kalibrace `--toy off` v T15 (vypnuto musí vyjít aspoň o 25 bodů níž); když ne, opravuje se otázka nebo pás snímků, práh zůstává.

## Výběr jmen pro generátor – `gen-nouns.json`

`node scripts/p37d/missing-nouns.mjs --out evals/play/p45d/missing.json` nad dnešním katalogem: 118 chybějících (P43 jich mělo 136). `node scripts/p45d/pick-nouns.mjs` z nich vybere 48: 2 hrdinové panelu (cyclops, mole), 29 podle počtu vět, 17 záměn soudce P43; 13 je plochých nebo drobných. Vyřazené jevy, kulisy a šum jsou v `scripts/p45d/not-models.txt`.

Unicorn (f08) a ninja cat (m09) knihovna kreslí (`covered`), hrdina modelem přesto chybí – to je výběr modelu ke slovu (P44C, `models.ts`), ne práce generátoru.

Třídu těla dává `bodyOfNoun` (`scripts/p45d/motion-class.mjs`); tvory, které `heroClass` nezná (mole, hippo, cyclops, robber …), doplňuje tabulka slov tamtéž, jinak by dostali šablonu předmětu.

## Třídy těl – `src/assets/catalog-motion.json`

`node scripts/p45d/motion-class.mjs` nad 929 modely: prop 412, biped 346, quadruped 56, vehicle 50, flyer 34, swimmer 31; pohyblivý díl s rolí má 14 modelů. Třídu dává nejdřív manifest hrdinů P32, pak `heroClass` nad jednoslovným id, pak poměr rozměrů; model s dveřmi je vždy prop.
