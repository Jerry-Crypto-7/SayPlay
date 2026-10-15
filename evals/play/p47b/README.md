# P47B – Akce z věty je ve hře

Plán: `plans/P47B-akce-z-vety-2026-10-15.md`. Ladí se jen na `verb-dev.json`, `evals/play/p46/action-sentences.json` a panelu P45. Holdout čte jen T12, jednou.

## Panel sloves (T1)

- **Kdo psal věty:** podagent naslepo 15. 10. 2026 – viděl jen pět akcí (`strike, dash, shield, shoot, grab`), jejich rodiny sloves a seznam žánrů. Neviděl kód, slovník (`ABILITY_CUES`, `extract.ts`) ani žádnou jinou sadu vět.
- **Rozsah:** 92 vět – 14 na každou akci (asi pětina se dvěma akcemi) a 22 pastí (`family: "trap"`, `wants: []`): podstatné jméno „shield/blocks“, sloveso nepřítele („sharks bite the hull“), složeniny („dodgeball“, „photo shoot“, „shooting stars“), zápor („never steal“) a slovesa žánru („pushes dung balls“, „kicks a football“).
- **Rozdělení:** po rodinách, `pure-rand` `xoroshiro128plus`, **semínko 4747**, Fisher–Yates přes `uniformInt`, prvních ⌈2n/3⌉ z každé rodiny do dev. Výsledek: `verb-dev.json` 65 vět, `verb-holdout.json` 27 vět.
- **Pečeť:** `holdout-seal.json` = SHA-256 holdoutu nad LF bajty. `__tests__/panel.test.ts` hlídá štítky, pokrytí (každá akce ≥ 6 vět v ≥ 4 žánrech dev), pasti (≥ 10 dev, ≥ 5 holdout), pečeť a překryv s panelem P45, větami P46A, test-200 a zapečetěnou sadou P45 (ta jen přes otisky normalizovaných vět).

## Rozhodnutí
