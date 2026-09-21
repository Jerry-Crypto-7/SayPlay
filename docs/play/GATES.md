# PLAY – brány vydání

Brány z `docs/play/pack/RELEASE_GATES.md`, u každé naměřené číslo, zdroj a verdikt
`PASS` / `FAIL` / `NOT MEASURED`. Čísla doplňuje plán P23-D (T3 harness, T5 tabulka,
T6 živé měření).

## Sloučeno

Stav 21. 9. 2026, větev `features/p23d-integration` nad `main` (`923b0be`):

- P23-A kompilátor a verifikátor – `98d8963` (#4) a `1f1714c` (#5, keypoint verifier,
  quality report, compile baseline).
- P23-B režisér – `98d8963` (#4).
- P23-C obálka – `98d8963` (#4) a `923b0be` (#6, `/play/[id]`, po-herní obrazovka,
  sdílení, OG obrázek).
- `npx tsc --noEmit` čistý; `npx vitest run src/play src/app/api/play src/components/play evals/play`
  27 souborů, 237/237 zelených.

## Nesloučeno

Nic. Všechny tři vrstvy jsou v historii; obálka ale do P23-D T1 běží nad dvojníky
kompilátoru a režiséra (`src/app/api/play/_compiler.ts`, `_director.ts`).

## Brány

Doplní T5.
