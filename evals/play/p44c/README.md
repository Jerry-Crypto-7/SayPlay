# P44C – otevřený slovník

Neznámé sloveso nebo podstatné jméno z věty dopadne offline tabulkou (Open English WordNet 2024 +
embeddingy) na existující mechaniku a model. Runtime jen čte mapu; `PLAY_VOCAB=off` vrací chování před P44C.

## Výchozí čísla (T1)

`baseline.json` z `baseline.measure.ts` nad `main` `434cc051` (P42 sloučený squashem v PR #26 – proto se P42
v `main` ověřuje obsahem `src/play/compose/`, ne předkem `65e449d5`, který squash do historie `main` nepřenesl).

| Sada | Vět | Výsledek |
|---|---|---|
| P42 vývojová (`p42/round5` → `held-out`) | 64 | zachováno 59 (`scoreTriples`) |
| `p37a/dev-150` | 150 | sloveso přečtené 104 |
| `p30/dev` | 60 | sloveso přečtené 44 |

Každý řádek nese i `intent` z `extractIntent` – proti němu T7 porovná `PLAY_VOCAB=off`.
`P44C_AFTER=1` týmž měřidlem zapíše `after-dev.json` (T13).
