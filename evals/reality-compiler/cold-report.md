# Reality Compiler — benchmark T10

Původ: live; sada: holdout.

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
  "origin": "live",
  "suiteStatus": "holdout",
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
    "completed": 0,
    "planned": 30,
    "attempted": 0
  },
  "precision": null,
  "recall": null,
  "latency": {
    "create": {
      "planned": 30,
      "successes": 0,
      "failures": 0,
      "notRun": 30,
      "timeouts": 0,
      "medianMs": null,
      "p95Ms": null
    },
    "edit": {
      "planned": 30,
      "successes": 0,
      "failures": 0,
      "notRun": 30,
      "timeouts": 0,
      "medianMs": null,
      "p95Ms": null
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
    "meanPairUsd": null,
    "maxPairUsd": null,
    "usdPerCompletedPair": null,
    "meanCallUsd": null,
    "calls": 0,
    "retries": 0
  },
  "limitation": "Small screening sample. Successful-run latency is conditional on completion. Offline/cache/prepared results never certify cold gates."
}
```

Archiv: runs/4842a649-a458-43e5-93e4-26c6540f72d2/. Přístup: autorizován přepínačem běhu; spend limit: NOT_RUN; provider: NOT_RUN; browser target: NOT_RUN.

Browser měří skutečnou stránku a stejný source handler přes označený lokální transport. Neměří hosting ani serverless cold start. Edit je lokální deterministický zásah. Sémantické a uživatelské brány vyžadují skutečné review; prázdná šablona není výsledek.
