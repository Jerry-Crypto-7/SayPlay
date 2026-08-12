<!-- GENEROVÁNO: node evals/coverage.js -- needitovat ručně -->

**Jmenovatel je 74 promptů se skutečným capability požadavkem, ne 116.**
Zbylých 42 (vague, contradictory, nonsense, hostile, perf) žádný požadavek neukládá –
projdou vakuově jakoukoli knihovnou, takže měří robustnost, ne pokrytí.

| Knihovna | FULFILLED | % | vs 3 archetypy |
|---|---:|---:|---:|
| 3 archetypy (spike) | 31/74 | 41.9% | — |
| 3 + trigger_chain | 36/74 | 48.6% | +6.8 b. |
| 3 + tend_grow | 34/74 | 45.9% | +4.1 b. |
| 3 + timing_rhythm | 34/74 | 45.9% | +4.1 b. |
| 3 + agent_ensemble | 34/74 | 45.9% | +4.1 b. |
| 3 + trigger_chain + tend_grow | 37/74 | 50.0% | +8.1 b. |
| 3 + trigger_chain + timing_rhythm | 38/74 | 51.4% | +9.5 b. |
| 3 + trigger_chain + agent_ensemble | 39/74 | 52.7% | +10.8 b. |
| 3 + tend_grow + timing_rhythm | 36/74 | 48.6% | +6.8 b. |
| 3 + tend_grow + agent_ensemble | 37/74 | 50.0% | +8.1 b. |
| 3 + timing_rhythm + agent_ensemble | 36/74 | 48.6% | +6.8 b. |
| všech 7 archetypů | 41/74 | 55.4% | +13.5 b. |

Mimo dosah i při 7 archetypech: **33** promptů (IC03, IC04, IC06, IC12, IC15, IC17, IC18, IC24, IC25, OC01, OC02, OC03, OC06, OC09, OC11, OC12, OC13, MD01, MD04, MD07, MD09, MD10, MD14, MD15, NE08, HO08, HO10, IT01, IT02, IT03, IT04, IT06, IT07).
