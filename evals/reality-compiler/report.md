Aktuální živé měření přes předplatné: [subscription report](subscription-report.md), [metoda a účetnictví](subscription-benchmark.md). Níže zůstává původní offline development report.

# Reality Compiler — benchmark T10

Původ: offline; sada: development.

Cold a uživatelské brány bez skutečného důkazu zůstávají NOT_RUN. Neznámá cena je UNKNOWN; rezervace není účtenka.

| Brána | Stav |
|---|---|
| invariants | NOT_RUN |
| criticalSupported | NOT_RUN |
| criticalCitations | NOT_RUN |
| rejectedUnchanged | NOT_RUN |
| visualUsable | NOT_RUN |
| problematicBlocked | NOT_RUN |
| completion | NOT_RUN |
| rules | NOT_RUN |
| createLatency | NOT_RUN |
| editLatency | NOT_RUN |
| promptLatency | NOT_RUN |
| cost | NOT_RUN |
| usersComplete | NOT_RUN |
| usersSpatialHelp | NOT_RUN |

Výsledky včetně jmenovatelů, timeoutů a podmíněných percentilů (nearest-rank, malý vzorek):

```json
{
  "origin": "offline",
  "suiteStatus": "development",
  "gates": {
    "invariants": "NOT_RUN",
    "criticalSupported": "NOT_RUN",
    "criticalCitations": "NOT_RUN",
    "rejectedUnchanged": "NOT_RUN",
    "visualUsable": "NOT_RUN",
    "problematicBlocked": "NOT_RUN",
    "completion": "NOT_RUN",
    "rules": "NOT_RUN",
    "createLatency": "NOT_RUN",
    "editLatency": "NOT_RUN",
    "promptLatency": "NOT_RUN",
    "cost": "NOT_RUN",
    "usersComplete": "NOT_RUN",
    "usersSpatialHelp": "NOT_RUN"
  },
  "completion": {
    "completed": 3,
    "planned": 3,
    "attempted": 3
  },
  "precision": null,
  "recall": null,
  "latency": {
    "create": {
      "planned": 3,
      "successes": 3,
      "failures": 0,
      "notRun": 0,
      "timeouts": 0,
      "medianMs": 627.4597999999996,
      "p95Ms": 813.6126999999999
    },
    "edit": {
      "planned": 3,
      "successes": 3,
      "failures": 0,
      "notRun": 0,
      "timeouts": 0,
      "medianMs": 46.722999999999956,
      "p95Ms": 53.20820000000003
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
    "knownUsd": 0,
    "totalUsd": 0,
    "unknownCosts": 0,
    "meanPairUsd": 0,
    "maxPairUsd": 0,
    "usdPerCompletedPair": 0,
    "meanCallUsd": null,
    "calls": 0,
    "retries": 0
  },
  "limitation": "Small screening sample. Successful-run latency is conditional on completion. Offline/cache/prepared results never certify cold gates."
}
```

Offline kontrola: 8 původních muzejních oracle případů a změněný výsledek, každý 3×. Čas je Node replay, nikoli ovladatelný browserový frame. Model se nevolal.

Archiv: runs/81e26e34-9084-4da2-b26e-3b8895f3b439/journal.jsonl a run.json.
