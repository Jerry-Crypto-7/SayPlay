# P81 rozdíl snímků: `evals/play/p81/base` → `evals/play/p81/r6`

Práh: kanál se pohnul o víc než 24/255. Odstín středu = kruhový průměr vážený sytostí ve výřezu x 0.35–0.65, y 0.4–0.8.

- Snímků v obou složkách: 24
- **Medián desktop-1play: 17.9 %**, nejmenší 15.2 %
- Medián všech snímků: 20.0 %
- Největší posun odstínu středu (desktop-1play): 9°
- Fialová (odstín 250–320°, chroma ≥ 24): nejvíc 0.03 % snímku před, 0.17 % po

| Hra | desktop start | desktop 3 s | desktop 8 s | telefon start | telefon 3 s | telefon 8 s | odstín středu 3 s (před → po, posun) | fialová nejvíc (před → po) |
|---|---|---|---|---|---|---|---|---|
| s3 | 20.0 % | 15.2 % | 26.3 % | 18.8 % | 26.6 % | 54.2 % | 31° → 30°, 1° | 0.01 % → 0.00 % |
| s4 | 14.7 % | 20.0 % | 18.7 % | 13.8 % | 17.2 % | 17.1 % | 30° → 24°, 6° | 0.00 % → 0.03 % |
| s8 | 13.9 % | 15.8 % | 15.9 % | 27.9 % | 20.4 % | 19.9 % | 32° → 26°, 6° | 0.00 % → 0.01 % |
| s11 | 32.7 % | 44.0 % | 28.6 % | 36.2 % | 57.9 % | 48.8 % | 32° → 22°, 9° | 0.03 % → 0.17 % |
