# Reality Compiler — T1 baseline a vykonatelný oracle

Datum: 7. 9. 2026. Výchozí commit: `b036efa5fc91fe50e932ce0c75a6ea34dfec6b74`.
Stav: T1 dokončeno; implementace hlavní cesty pilotu ještě neproběhla.

## Výchozí pracovní strom
Před T1 existovaly změny `src/app/page.tsx` a `e2e/second-act.spec.ts` z převzetí projektu (oprava zámku nové relace). Necommitnutý `e2e/model-demo.spec.ts` pochází od uživatele a zůstal nedotčený. Baseline není vydávána za čistý commit ani nasazený artefakt.

## Důkaz
- Vlastní fiktivní podklad: `museum-source.txt`, jeho SHA-256 je připnut v `oracle.json`.
- Nezávislé očekávání: `oracle.json`, dev sada; nejde o hidden benchmark ani výstup generátoru.
- Ručně deklarovaný vykonatelný svět: `museum.sim.json`, skutečný povrch pro `buildRuntimeWorld`, ne druhý interpret v testu.
- Test: `src/sim/__tests__/museum-oracle.test.ts`, 18 případů včetně negativních a mutačních kontrol.
- Cílená sada s lowering, timeline a rebranch: 62/62 testů prošlo, exit 0.
- `npm run typecheck`: exit 0.
- Žádný model, API nebo placené generování nebyly použity.

Reprodukce z kořene repozitáře:

```powershell
npx vitest run src/sim/__tests__/museum-oracle.test.ts src/sim/__tests__/timeline.test.ts src/sim/__tests__/rebranch.test.ts src/ir/__tests__/build.test.ts
npm run typecheck
```

Žádný test nepotřebuje ignorovaný `plans/` adresář. Lokální podrobný výsledek je `scratch/museum-baseline-results.json`; k reprodukci není potřeba.

## Co bylo prokázáno
1. A spustí časovač, opakování jej neobnoví. B před A se nezapamatuje.
2. Včasné B otevře vitrínu, pozdní nebo přesně hraniční B ji neotevře.
3. Vzdálené aktivace A/B neprovedou chráněnou akci. Pohyb mění skutečnou pozici avatara, ne pouze vykreslení.
4. Existující runtime respektuje neprůchodnou buňku a vzdálený vstup ji neobejde. Tento test nastavuje runtime prostor přímo; nedokládá lowering zdí ze zdrojového dokumentu.
5. Stejný log vstupů a změna jediného startTimer pravidla 400→200 dají při společném horizontu 300 odlišné výsledky.
6. Původní větev zůstane zachovaná, odvozená větev umí rewind/replay. Změna kapacity timer slotu je správně odmítnuta bez přetočení původního stavu.
7. Záměrné oslabení podmínky expirace a odstranění prostorové stráže poruší nezávislá očekávání.

## Rozhodnutí z měření
**Neměnit engine ani frekvenci.** Časovač má v obou větvích stejnou kapacitu 400. Zásah mění pouze `startTimer.durationTicks`. Změna deklarace kapacity by změnila strukturu stavu a rebranch by ji odmítl.

**Pojmenovat hranici tiku.** Vstup v tiku N se vykoná z pre-stavu N a výsledek je snapshot N+1. A v tiku 20 nastaví 400; settle téhož tiku sníží stav na 399. Timeout se vyhodnotí při vstupním tiku 420, alarm je vidět ve snapshotu 421. Původní slovní oracle používal „atTick“ nejednoznačně; nový má `snapshotTick`.

**Oddělit stav výsledku od ukončení hry.** Pozorovací fixture zůstává po otevření vitríny běžící, aby šly číst stejné simulační ticky. Sama proto nemá win certifikát. Varianta s explicitním efektem `win` se skutečně certifikuje a skončí ve snapshotu 261; zkrácená varianta stejnou stopou nevyhraje. `seekTo(..., 300)` u ukončené větve vrátí 261, což je správné chování enginu.

Pro hlavní integraci zachovat win certifikaci. Budoucí controller zvlášť eviduje requested observation tick a skutečný runtime tick/endedAtTick. Při pozorování pozdějšího horizontu lze zobrazit konečný stav ukončené větve s jeho časem ukončení; nelze tvrdit, že engine provedl další ticky. Tento adaptér je úloha T3/T5, zde se netváří jako hotový.

**Nevydávat geometrii za kolize.** `buildRuntimeWorld` stále konstruuje `space.blocked` jako prázdné pole. Pilotová otevřená místnost to nepotřebuje, ale procedura vyžadující zeď jako mechanickou překážku musí být odmítnuta nebo dostat výslovný prostorový adaptér. Test runtime bariéry nedokazuje, že ji již umí generovací pipeline.

## Co ještě hotové není
UI propojení runtime, evidence kontrakt, import textu modelem, transakční propojení světa a evidence, ovládání scénáře na hlavní URL a compare. T1 prokazuje použitelný základ a konkrétní integrační hranice, nikoli splnění cold/user bran ani finální kvalitu produktu.
