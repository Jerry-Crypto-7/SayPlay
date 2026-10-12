# P45B – konečné měření na vývojovém panelu P45A (9. 10. 2026)

Commit `f1b88a66` (P45B po T12a, `origin/main` s P45A a P45E sloučený). Panel `evals/play/p45/panel.json`,
40 vět; zapečetěná sada P45 se neotevřela. Čísla jsou zapsaná, jak padla – nic se nepřeměřovalo ani neladilo.

```
set P45B_SET=evals/play/p45/panel.json && set P45B_OUT=evals/play/p45b/final.json && npx vitest run --config vitest.measure.mts evals/play/p45b/logic-share.measure.ts
set P45_SET=panel && set P45_OUT=<soubor> && npx vitest run --config vitest.measure.mts evals/play/p45/fun.measure.ts
```

Souhrny cílů, režiséra, obtížnosti a telemetrie jsou ve `final.json` vedle řádků podílu logiky.

## Cíle P45B

| cíl | hodnota | splněno |
|---|---|---|
| okamžitý návrh používá fázi, časovač nebo proměnnou ≥ 40 % | **45 %** (18/40; fáze 18, vlna 18, časovač 13, proměnná 0) | ano |
| režisér – zaznamenané odpovědi projdou ≥ 80 % | **1/25** (4 %) | **ne** |
| hratelné 100 % | 40/40 | ano |
| determinismus (přehrání) 100 % | 40/40 | ano |
| nečinný hráč nevyhraje | 40/40 | ano |
| p95 návrhu ≤ 2 s | 874 ms (p50 400 ms) | ano |
| novice 0,3–0,7 | 54/54 buněk (`p41/difficulty.json`) | ano – s výhradou níže |

- **Režisér 1/25 – příčina:** gpt-oss-20b opíše začátek vzoru (první fáze spustí časovač), ale druhou
  fázi nechá mrtvou (18/25), časovač nespustí (12/25) nebo pošle vlnu od okraje v žánru bez podlahy;
  kritik pak logiku zahodí a hra ztratí svědka věty. Dvě úpravy promptu (T12a) hnuly zapojení, ne
  výsledek. Rozbor: `README.md` → T11 a T12a.
- **Hratelnost, determinismus, nečinný hráč** jsou jedna kontrola: `publishEligible` z `verifyArcade`
  selže, když robot nevyhraje, nečinný hráč vyhraje nebo se dvě přehrání liší.
- **Novice – výhrada:** měřidlo obtížnosti P41 skládá buňky bez záměru, takže šablony s logikou do něj
  nevstupují; 18 panelových her s logikou tím pokryté není. Pokrytí by chtělo nové měřidlo nad panelem.
- Pomalé návrhy: h02 1 699 ms a s003 1 564 ms, obě se šablonou `coin_shower`.

## Telemetrie P45A – `main` bez P45B a s ním (jen zapsat)

`main` = `evals/play/p45/baseline.json` (`0714a352`); `origin/main` od té doby nemění kód hry, jen
přidal telemetrii. HEAD = tenhle commit. Robot `intermediate`, 40/40 hratelných na obou stranách.

| metrika | `main` | P45B | cíl spec (P45C+D) |
|---|---|---|---|
| mrtvý čas – medián `longestGapS` | 6,37 s | **4,76 s** | ≤ 3 s |
| podíl `rising` | 0,40 | **0,48** | ≥ 0,70 |
| medián `eventsPerS` | 0,94 | **1,08** | – |
| chování – medián `behaviourCount` | 1 | 1 | ≥ 2 |
| podíl s finále | 0,15 | **0,10** | ≥ 0,50 |
| medián `nearMisses` | 0 | 0 | – |
| medián `livesLost` | 0 | 0 | – |

Žádný cíl zábavy splněný není ani před P45B, ani po něm; patří P45C+D. **Odvozeno, ne změřeno:**
pokles finále 0,15 → 0,10 jsou dvě hry z 40 – šablona mohla prodloužit běh nebo rozředit konec,
na kterém stojí `climax`.
