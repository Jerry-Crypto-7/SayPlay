# P45B – jazyk pravidel v2: měření

## Měřidlo podílu logiky (`logic-share.ts`)

Pro každou větu spustí okamžitý návrh (`draftGameSpecWithMeta`, semínko 1, bez modelu), změří čas
návrhu a hru ověří (`verifyArcade`). Hra **používá logiku**, jen když spec deklaruje blok `logic`,
aspoň jedno pravidlo má logický spouštěč, podmínku nebo efekt **a** robot ji dohraje. Čte jen
vývojové sady; testovací a zapečetěné sady odmítne (`openSet`, test `__tests__/logic-share.test.ts`).

```
npx vitest run --config vitest.measure.mts evals/play/p45b/logic-share.measure.ts
P45B_OUT=evals/play/p45b/dev.json npx vitest run --config vitest.measure.mts evals/play/p45b/logic-share.measure.ts
```

`P45B_SET` (čárkou oddělené cesty) vymění sady, `P45B_OUT` výstupní soubor.

## Baseline (`baseline.json`, `main` `0714a352`, 8. 10.)

Sady `p30/dev.json` (60) + `p37a/dev-150.json` (150) = 210 vět.

| | |
|---|---|
| hratelné | 210/210 (100 %) |
| používá logiku | 0 (0 %) |
| p50 návrhu | 202 ms |
| p95 návrhu | 509 ms |

Strop pro T9: p95 ≤ 2000 ms a ne horší než 509 × 1,25 = **636 ms**. Časy jsou z jednoho běhu na
vývojovém stroji; srovnávat jen běhy pouštěné samotné (bez buildu a agentů na pozadí).
