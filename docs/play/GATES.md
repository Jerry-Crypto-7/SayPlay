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

Stav 21. 9. 2026, T5. Každá řádka: cíl z balíčku, naměřené číslo (nebo `NOT MEASURED`), zdroj
a verdikt. Čísla bez modelu jdou přes návrh ze slov (`src/play/draft`), semínko 1; čísla s modelem
jsou jediný živý běh režiséra 20. 9. (`gpt-6-astra`, 8 vět). Zdroje:
`evals/play/regression/report.json` (harness T3, 40 zlatých vět), `evals/play/compiled/report.json`
(8 archetypů × 5 semínek), `evals/play/director-live.json` (režisér živě), e2e `play-*` (17/17 zelených
21. 9. nad `next start`). `NOT MEASURED` znamená, že nic v repu to číslo nevyrábí.

| Brána | Cíl | Naměřeno | Zdroj a test, který ji hlídá | Verdikt |
|---|---|---|---|---|
| P0 crash | žádný pád na korpusu | 40/40 vět návrh → kompilace → kontrola bez výjimky; e2e `play-*` 17/17 | `regression/report.json`; `evals/play/regression/golden.test.ts` | PASS |
| P0 deterministic mismatch | replay = běh | `replayEqual` 40/40 běhů (8 archetypů × 5 semínek) | `compiled/report.json`; `src/play/__tests__/verify.test.ts` („proves every assertion of all eight archetypes“, `replayEqual`) | PASS |
| P0 broken objective | nevyhratelná hra se nepublikuje | `publishEligible` 40/40 korpusu; nevyhratelné rozvržení → 422 `UNWINNABLE`, neprošlý keypoint → 422 `NOT_PUBLISHABLE` | `verify.test.ts` („fails reachability when the witness never wins“); `src/app/api/play/__tests__/routes.test.ts` | PASS |
| P0 missing controls/spawn | každá hra má hráče a cíle na klepnutí | NOT MEASURED | – | NOT MEASURED |
| P0 lineage drift | rodokmen se nemění po publikaci | rodokmen zapsaný jednou při publikaci, čtení 1 příkaz, strop 32 záznamů, podvržený rodič nevyrobí cyklus | `src/play/__tests__/version.test.ts` („caps a long lineage at the 32 newest entries…“, „a forged parent… cannot make a cycle“) | PASS |
| P0 public version regeneration | publikovaná verze se nepřepíše | táž hra podruhé = 200 `exists`, cizí obsah pod týmž id = 409 `conflict`, původní záznam zůstává | `version.test.ts` („stores once, answers exists…“); `routes.test.ts` („(8) remix nepřepíše rodiče…“) | PASS |
| P0 moderation block | obsah volajícího neprojde na veřejnou plochu bez kontroly | 0 kontrol obsahu; titul autorské verze jde ovlivnit větou a ukáže se ve feedu (revize T4-2); vypnout jde pákou `feed` | revize T4-2 z 21. 9. 2026 (mimo repo) | FAIL |
| P0 secret exposure | žádný secret v odpovědi ani v bundlu | NOT MEASURED | – | NOT MEASURED |
| ≥ 95 % korpusu hratelné | ≥ 95 % | 40/40 = 100 % (návrh ze slov) | `regression/report.json` `summary.eligible` | PASS |
| p50 < 12 s / p90 < 25 s – návrh | do hratelné hry | p50 53,6 ms, p90 260,5 ms (návrh + kompilace + kontrola na serveru, bez sítě) | `regression/report.json` (`draftMs + compileMs + verifyMs`) | PASS |
| p50 < 12 s / p90 < 25 s – autorská verze | do verze od režiséra | p50 40 405 ms, p90 55 024 ms (8 vět) | `director-live.json` `summary` | FAIL |
| vodopád T2 přes API | ack a hratelný návrh přes HTTP | NOT MEASURED – měří T6 (`evals/play/regression/live.json`) | – | NOT MEASURED |
| ≥ 90 % zlatých vět bez plné regenerace | ≥ 90 % | 40/40 zkompilováno napoprvé; živě 0 opravných kol v 8/8 | `regression/report.json`; `director-live.json` `repairRounds` | PASS |
| 100 % replay korpusu | 100 % | 40/40 | `compiled/report.json` | PASS |
| rozpočty entit a pravidel | server růst vynutí | 40/40 v rozpočtu (součást `publishEligible`); odhad pravidel registru není horní mez (R1 otevřený) | `src/play/verify/index.ts:129`; `compiled/report.json` | PASS |
| anonymní sdílená hra | odkaz hraje bez účtu | e2e `play-share` zelené v 17/17 | `e2e/play-share.spec.ts` | PASS |
| rodič se po remixu nemění | neměnný rodič | remix 201, rodič beze změny, stejný remix podruhé 200 `exists` | `routes.test.ts` („(8) remix nepřepíše rodiče…“) | PASS |
| replay a remix po hře | po-herní obrazovka funguje | e2e `play-postrun` zelené v 17/17 | `e2e/play-postrun.spec.ts` | PASS |
| technické UI není potřeba | cizí člověk hraje bez vysvětlení | NOT MEASURED – HALT „tři cizí lidé hrají“ | – | NOT MEASURED |
| trvalý backend | hra a upgrade přežijí restart | NOT MEASURED – upgrade na pozadí drží `after()` jen do `maxDuration` (R7) | – | NOT MEASURED |
| health endpoint | odpovídá na nasazení | NOT MEASURED – `src/app/api/health/route.ts` existuje, na nasazení neověřeno | – | NOT MEASURED |
| externí monitor dostupnosti | běží | NOT MEASURED | – | NOT MEASURED |
| strop frekvence a útraty | kousne | 51. požadavek v okně → 429; denní strop publikací 500 → 429 `PUBLISH_QUOTA` | `routes.test.ts` („(7) 51. požadavek…“, „denní strop publikací…“) | PASS |
| výpadek poskytovatele | hra zůstane hratelná | živě 1/8 vět spadla na návrh a hra zůstala hratelná; bez modelu upgrade = `draft-final` | `director-live.json`; `src/app/api/play/__tests__/upgrade.test.ts` | PASS |
| přesný commit a nasazení | připnuté | NOT MEASURED | – | NOT MEASURED |

**Návrh vs. autorská verze.** Cíl `p50 < 12 s` splní návrh ze slov s rezervou přes dva řády (p50 53,6 ms); autorská verze od
režiséra ho nesplní (p50 40,4 s). Progresivní hra z T2 proto ukazuje návrh hned a autorskou verzi
nabídne, až doběhne – hráč nečeká na model, jen na lepší verzi.
