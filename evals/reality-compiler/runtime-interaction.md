# T4 — prostorové vstupy a trace pravidel

Datum: 7. 9. 2026.

## Implementace

Hlavní URL nabízí vstupy deklarované v IR. `runtime-input.ts` je adaptér nad existujícími fakty `acted`; nepřidává pravidla ani nevynucuje vlastní kopii prostorových podmínek. `moveTo` zadává existujícímu enginu cíl pohybu. `activate` projde stejným krokem enginu; vzdálené aktivaci zabrání prostorová podmínka muzejního pravidla.

Controller přiděluje vstupu aktuální tick, zapíše jej do logu a provede jeden skutečný krok. Vrací `StepResult.fired` jako `ruleIds`. Neúspěšná aktivace zůstává zaznamenaným vstupem bez spuštěného pravidla. Časovače a ostatní autonomní pravidla vstupují do stejného trace. UI čte polohu, zámky, příznaky a časovače ze snapshotu; nevytváří lokální úspěch kliknutím.

Panel uchovává posledních 60 tiků s událostí nebo spuštěným pravidlem; vstupní log zůstává kompletní pro replay. Pozorování minulosti nepovoluje nové vstupy, dokud se controller nevrátí na poslední dosažený tick. Pauza a ukončený běh vstupy odmítají. Bezpečné větvení z minulosti zůstává T5. Pozdní dějství II po návštěvníkově vstupu nabídne modelový svět k převzetí místo automatického resetu rozehraného světa.

## Ověření

- Cílené unit testy controlleru, vstupů, nezávislého museum oracle, timeline a rebranch: 62/62.
- TypeScript prošel.
- Produkční build prošel samostatně. První společný pokus překročil 240s limit buildu a startu serveru, bez spuštění testů.
- Browserová sada prošla 8/9; zbývající test prošel asercemi a vypršel při screenshotu. Po prodloužení jeho limitu prošel 1/1. Souhrnně všech devět případů prošlo, včetně ochrany rozehraného světa před dějstvím II.
- Vizuální kontrola screenshotu odhalila, že původní kamera nezahrnovala přesunutého návštěvníka. Nová browserová aserce proti původnímu buildu selhala právě na projekci návštěvníka mimo viewport (`Expected: true; Received: false`). Rámování nyní zahrnuje skutečné posuny slotů ze snapshotu. Závěrečný produkční build a TypeScript prošly; browserová sada T4 + T3 prošla 4/4 za 3,2 minuty. Snímek `scratch/reality-compiler-interaction.png` byl vizuálně zkontrolován a návštěvník zůstává v záběru.

Reprodukce unit sady:

```powershell
npx vitest run src/worldstream/__tests__/runtime-input.test.ts src/worldstream/__tests__/runtime-controller.test.ts src/sim/__tests__/museum-oracle.test.ts src/sim/__tests__/timeline.test.ts src/sim/__tests__/rebranch.test.ts
```

Browserová sada: `e2e/reality-compiler-interaction.spec.ts`, `e2e/reality-compiler-runtime.spec.ts`, `e2e/second-act.spec.ts`, projekt `chromium`. Kvůli společnému startovacímu limitu je build spuštěn samostatně s `CIRCLE_NODE_TOTAL=3`; po jeho úspěšném dokončení běží `next start` na `127.0.0.1:3117` a Playwright dostává `FALLBACK_SMOKE_URL=http://127.0.0.1:3117`. Živý endpoint je v prostředí serveru prázdný. Testy muzea nahrazují transport fixture, Act II používá scriptovaný proud.

## Hranice důkazu

Browserová fixture používá scriptovaný transport autorovaného muzejního `sim`, skutečný controller a renderer na `/`. Není to měření modelu ani záruka prostorových podmínek každého generovaného světa. Zákaz vzdálené aktivace patří podmínkám pravidla, nikoli univerzální vzdálenosti přidané do UI. Stav vitríny a alarmu je vidět v panelu; geometrie fixture ověřuje pohyb slotu návštěvníka. Chybějící lowering zdí a shoda generované geometrie se simulační mřížkou zůstávají omezeními popsanými v baseline.
