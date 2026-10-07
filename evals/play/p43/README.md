# P43 – co porotce vidí

Měření viditelnosti akce a poznatelnosti hrdiny a věcí. Plán: P43 (interní), spec `docs/specs/2026-10-07-p43-co-porotce-vidi.md` (interní).

## `sealed-100.json` – zapečetěná sada, 100 vět

Napsaná 7. 10. 2026 dřív, než se P43 dotkl kódu, autorem bez přístupu ke kódu P43, k `p30/test-200.json`, `p37`, `p41` a `p42` (jediný čtený soubor byl formát `p37a/dev-150.json`). Skupiny: `action` 35, `unknown-verb` 25, `fantasy` 22, `non-game` 18; pět vět s překlepem nese štítek `typo`.

SHA-256 (konce řádků LF): `6ae90a7051a55ff2664e75e376689ce7d3fd8bbdf54910384f9bf6f46caf8035`, hlídá ho `__tests__/sealed.test.ts`.

- Žádná věta se po převodu na malá písmena a bez interpunkce neshoduje s `p30/test-200.json`, `p30/dev.json`, `p37a/dev-150.json`, `fidelity/corpus.json`, `fidelity/judge-10.json`, `demand/corpus.json` ani `p41/sentences.json`.
- Na sadě se neladí a její věty nikdo z P43 nečte. Pečeť rozhoduje obsah (`source: "sealed-p43"`), ne cesta.

### Otevření (jednou, na konci P43)

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set p43-sealed --open-sealed-once --clip --draft-only --run <id>
```

Bez `--open-sealed-once` (nebo `--open-test-once`) běh odmítne. S ním se před první větou zapíše `sealed-opened.json` (čas, běh, commit, SHA-256) a každé další otevření odmítne.

## `missing.json` – podstatná jména bez modelu

`npx vitest run --config vitest.measure.mts evals/play/p43/missing.measure.ts` – sady demand, fidelity, judge-10, P30 dev, dev-150 a celá P41 (od P42 vývojová). Zapečetěné sady se nečtou.

7. 10. 2026 nad `ce5145d0`: 689 vět, **missing 136**, covered 853, undrawable 32, settings 85, unclassified 278. Chybějící jména jsou skoro všechna v jedné až čtyřech větách (nejčastější `fire` 4, `scarf` 3) – nízké „hrdina modelem“ a „položka modelem“ tedy dělá hlavně výběr modelu k větě, ne chybějící modely.
