# P46 – hratelnost: měření

## Sloveso → akce (P46A)

`actions.ts` vezme 40 vět panelu P45 a 20 vět se slovesy akcí (`action-sentences.json`, napsané 12. 10. 2026 mimo zapečetěné sady). U každé věty zjistí:

- `wantsAction` – věta chce akci hrdiny: shoot, strike (fight/punch/kick), grab (steal/grab/snatch), dash (dash/dodge), shield (block/shield/defend/protect). Počítají se nejvýš první 2 podle pořadí ve větě.
- `hasAction` – rychlá verze dala hrdinovi každou chtěnou akci (`abilities`, dnes doplněk střelby, žánr střelce nebo souboj).
- `botUsed` – hra akci má a robot `intermediate` ji použil.
- `verbFired` – pravidlo každé akce, kterou hra má, se spustilo. U střelby se počítá zásah, ne výstřel do prázdna.

Podíly se počítají jen nad větami, které akci chtějí.

```
P46_OUT=<soubor> npx vitest run --config vitest.measure.mts evals/play/p46/actions.measure.ts
```

Bez `P46_OUT` se zapíše `actions-baseline.json`.

## Výchozí stav (větev P45 `491079b7`, 12. 10. 2026)

| Měření | Hodnota |
|---|---|
| věty, které chtějí akci | 25 z 60 |
| `hasAction` | 0,24 |
| `botUsed` | 0,28 |
| `verbFired` | 0,28 |

Akci dnes dostanou jen věty se střelbou v řízení, letu a žánru střelce. Bití, krádež, uhnutí a štít nemá žádná hra. Cíl P46A (T10) je u všech tří čísel ≥ 0,85.

Zábava panelu P45 nad touto větví (`fun-baseline.json`, 40 hratelných her): mrtvý čas medián 5,36 s, gradace 0,55, počet chování medián 1, finále 0,23.
