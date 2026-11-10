# P81 rozdíl snímků: `evals/play/p81/base` → `evals/play/p81/r3`

Práh: kanál se pohnul o víc než 24/255. Odstín středu = kruhový průměr vážený sytostí ve výřezu x 0.35–0.65, y 0.4–0.8.

- Snímků v obou složkách: 24
- **Medián desktop-1play: 36.4 %**, nejmenší 16.9 %
- Medián všech snímků: 34.2 %
- Největší posun odstínu středu (desktop-1play): 9°
- Fialová (odstín 250–320°, chroma ≥ 24): nejvíc 2.15 % snímku před, 0.17 % po

| Hra | desktop start | desktop 3 s | desktop 8 s | telefon start | telefon 3 s | telefon 8 s | odstín středu 3 s (před → po, posun) | fialová nejvíc (před → po) |
|---|---|---|---|---|---|---|---|---|
| s4 | 24.1 % | 32.9 % | 28.9 % | 26.7 % | 47.8 % | 41.3 % | 30° → 29°, 1° | 0.00 % → 0.03 % |
| s9 | 37.8 % | 40.6 % | 44.4 % | 35.0 % | 68.5 % | 65.2 % | 154° → 147°, 7° | 0.01 % → 0.00 % |
| s11 | 30.9 % | 39.8 % | 27.9 % | 35.8 % | 60.7 % | 52.6 % | 32° → 22°, 9° | 0.03 % → 0.17 % |
| s12 | 11.4 % | 16.9 % | 14.4 % | 17.0 % | 33.5 % | 21.9 % | 236° → 231°, 5° | 2.15 % → 0.07 % |
