# Reality Compiler — živý subscription benchmark T11

Původ: live; sada: holdout.

Cold a uživatelské brány bez skutečného důkazu zůstávají NOT_RUN. Neznámá cena je UNKNOWN; rezervace není účtenka.

| Brána | Stav |
|---|---|
| invariants | PASS |
| criticalSupported | NOT_RUN |
| criticalCitations | NOT_RUN |
| rejectedUnchanged | PASS |
| visualUsable | NOT_RUN |
| problematicBlocked | FAIL |
| completion | PASS |
| rules | NOT_RUN |
| createLatency | FAIL |
| editLatency | PASS |
| promptLatency | NOT_RUN |
| cost | NOT_RUN |
| usersComplete | NOT_RUN |
| usersSpatialHelp | NOT_RUN |

Výsledky včetně jmenovatelů, timeoutů a podmíněných percentilů (nearest-rank, malý vzorek):

```json
{
  "origin": "live",
  "suiteStatus": "holdout",
  "gates": {
    "invariants": "PASS",
    "criticalSupported": "NOT_RUN",
    "criticalCitations": "NOT_RUN",
    "rejectedUnchanged": "PASS",
    "visualUsable": "NOT_RUN",
    "problematicBlocked": "FAIL",
    "completion": "PASS",
    "rules": "NOT_RUN",
    "createLatency": "FAIL",
    "editLatency": "PASS",
    "promptLatency": "NOT_RUN",
    "cost": "NOT_RUN",
    "usersComplete": "NOT_RUN",
    "usersSpatialHelp": "NOT_RUN"
  },
  "completion": {
    "completed": 30,
    "planned": 30,
    "attempted": 30
  },
  "precision": null,
  "recall": null,
  "latency": {
    "create": {
      "planned": 30,
      "successes": 30,
      "failures": 0,
      "notRun": 0,
      "timeouts": 0,
      "medianMs": 126221.85000002384,
      "p95Ms": 180431.60000002384
    },
    "edit": {
      "planned": 30,
      "successes": 30,
      "failures": 0,
      "notRun": 0,
      "timeouts": 0,
      "medianMs": 2418.9999999403954,
      "p95Ms": 3727.4000000953674
    },
    "prompt": {
      "planned": 0,
      "successes": 0,
      "failures": 0,
      "notRun": 0,
      "timeouts": 0,
      "medianMs": null,
      "p95Ms": null
    }
  },
  "cost": {
    "billing": "subscription",
    "knownUsd": 0,
    "totalUsd": null,
    "unknownCosts": 36,
    "meanPairUsd": null,
    "usage": {
      "inputTokens": 455429,
      "outputTokens": 78841,
      "unknownCalls": 0
    },
    "maxPairUsd": null,
    "usdPerCompletedPair": null,
    "meanCallUsd": null,
    "calls": 36,
    "retries": 0
  },
  "limitation": "Small screening sample. Successful-run latency is conditional on completion. Offline/cache/prepared results never certify cold gates."
}
```

Archiv: runs/0143dcc9-ea30-4519-ada3-b47ff02bdf5b/. Každý pokus zůstal v reportu. Předplatné nemá doloženou jednotkovou USD cenu; cenová brána NOT_RUN. Lokální generace bez prepared/cache odpovědí; nejde o cold serverless start. Sémantické a lidské brány vyžadují skutečná pozorování.

## Interpretace a meze konečné série

Konečná série 0143dcc9-ea30-4519-ada3-b47ff02bdf5b dokončila 30/30 párů, 36/36 CLI volání, bez timeoutu a bez stop reason. Invarianty, očekávané rozdíly větví a zachování stavu při odmítnutí prošly ve všech 30 párech. H06–H08 ve všech třech opakováních nevyžádaly upřesnění: 9 doložených selhání z 15 problematických párů, brána FAIL. Zbývajících šest vyžádalo upřesnění, správnost jeho obsahu čeká na lidské review. Vytvoření: medián 126,22 s / p95 180,43 s (FAIL proti 30/60 s); změna: medián 2,42 s / p95 3,73 s (PASS proti p95 8 s).

Usage: 455 429 vstupních a 78 841 výstupních tokenů; žádné volání nemá neznámou usage. Jednotková USD cena je null, nikoli nula. Počet 36 označuje logické CLI pokusy; interní HTTP retry CLI nejsou samostatně pozorovány. Podrobné cache/reasoning údaje jsou v subscription.jsonl.

Kritické i ostatní citace mají sémantické review NOT_RUN; ostatní citace se vykazují samostatně bez nového číselného prahu. Pravidlová precision/recall, vizuální použitelnost a lidské výsledky zůstávají NOT_RUN (0/5 lidí). Prompt-only režim ani hosting nebyly měřeny. Lokální měření probíhalo souběžně s vývojovými kontrolami a jinými aplikacemi, nikoli na izolovaném produkčním stroji. Testované podklady byly v limitu lokálního dema 2 000 znaků; úplná podpora delších podkladů tím není doložena.

[Metodika a všechny předchozí pokusy](subscription-benchmark.md). [Rozhodnutí T12](decision.md).
