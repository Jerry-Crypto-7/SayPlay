# Reality Compiler — T3 runtime na hlavní scéně

Datum: 7. 9. 2026. Změny jsou v pracovním stromu, bez publikování.

## Implementace

`src/worldstream/runtime-controller.ts` vlastní jediný existující interpret a timeline. Publikuje neměnné snímky pro React a scénu; renderer nemá vlastní runtime ani simulační hodiny. Živý čas převádí stávající fixní clock na ticky. Pause/resume zachovává stav a při obnovení nedohání čas strávený v pauze.

Hlavní stránka zakládá runtime z přijatého blueprintu. Stejná relace a stejný obsah `sim` zachovají controller při změně vzhledu, nové JS referenci i překreslení. Nová relace začne nový běh. Certifikační witness zůstává v dokumentu, ale interaktivní controller jej automaticky nepřehrává za návštěvníka.

`observationTick` je požadovaný horizont; `tick` je skutečný čas enginu. Ukončená větev zůstává v konečném stavu a uvádí `endedAtTick`. Oracle s efektem win končí na tiku 261 a při pozorování tiku 300 nepředstírá dalších 39 kroků. Přetočení před výhru a opětovné přehrání zachová výsledek i původní win certifikaci.

`WorldstreamStage` promítá pozici a aktivitu entit do existujících obalů slotů. Posun je relativní k autorské kotvě, v jednotkách stávajícího `CELL_SIZE`; nesčítá se při opakovaném renderu. Popisky a diagnostika čtou skutečnou pozici obalu. Stav enginu není odvozován z geometrie.

## Ověření

- 12 nových unit případů; cílená sada controller + museum oracle + timeline + rebranch prošla 59/59.
- TypeScript prošel.
- První browserová sada nad produkčním buildem prošla 9/9: pause/look commit, main path a second act včetně závodů.
- Závěrečný produkční build a oba browserové testy prošly 2/2. Časovač posunul skutečný obal slotu o sedm polí bez nové stavby scény. Snímek `scratch/reality-compiler-runtime.png` byl vizuálně zkontrolován; ovládání nepřekrývá vstupní pole.
- Žádná placená inference. Test pohybu dodává explicitně autorovaný blueprint přes scriptovaný transport; interpret i WebGL renderer jsou skutečné.

Reprodukce:

```powershell
npx vitest run src/worldstream/__tests__/runtime-controller.test.ts src/sim/__tests__/museum-oracle.test.ts src/sim/__tests__/timeline.test.ts src/sim/__tests__/rebranch.test.ts
npm run typecheck
$env:WORLDSMITH_MODEL_ENDPOINT = ''
$env:CIRCLE_NODE_TOTAL = '3'
npx playwright test e2e/reality-compiler-runtime.spec.ts e2e/second-act.spec.ts e2e/worldstream-main-path.spec.ts --project=chromium --grep-invert '@measure'
```

## Hranice T3

Navazující [T4 — prostorové vstupy a trace](runtime-interaction.md) již připojuje ovládání muzea na hlavní stránku; původní mezera T3 je tím uzavřena. Změna obsahu `sim` nyní zakládá nový běh. Zachování a porovnání větví při změně pravidla je T5/T6, nikoli důkaz získaný změnou vzhledu. Observation/rewind API controlleru ještě není uživatelské compare UI. Evidence nadále nemá HTTP/UI integraci. Autorské souřadnice slotů nejsou důkazem prostorové shody ani kolizí generovaného světa.
