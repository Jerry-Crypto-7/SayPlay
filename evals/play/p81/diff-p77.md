# P81 rozdíl snímků: `evals/play/p81/base` → `evals/play/p77/after`

Práh: kanál se pohnul o víc než 24/255. Odstín středu = kruhový průměr vážený sytostí ve výřezu x 0.35–0.65, y 0.4–0.8.

- Snímků v obou složkách: 72
- **Medián desktop-1play: 0.5 %**, nejmenší 0.0 %
- Medián všech snímků: 0.4 %
- Největší posun odstínu středu (desktop-1play): 17°

| Hra | desktop start | desktop 3 s | desktop 8 s | telefon start | telefon 3 s | telefon 8 s | odstín středu 3 s (před → po, posun) |
|---|---|---|---|---|---|---|---|
| s1 | 2.2 % | 2.6 % | 1.7 % | 1.9 % | 8.0 % | 7.1 % | 23° → 23°, 0° |
| s2 | 0.5 % | 2.1 % | 2.0 % | 0.0 % | 0.4 % | 0.0 % | 39° → 39°, 0° |
| s3 | 3.8 % | 0.0 % | 0.0 % | 0.2 % | 0.2 % | 1.2 % | 31° → 31°, 0° |
| s4 | 0.2 % | 0.0 % | 0.0 % | 0.2 % | 0.1 % | 0.1 % | 30° → 30°, 0° |
| s5 | 0.2 % | 0.9 % | 0.4 % | 1.9 % | 1.5 % | 2.8 % | 46° → 46°, 0° |
| s6 | 0.1 % | 0.0 % | 0.0 % | 0.1 % | 0.0 % | 0.0 % | 14° → 14°, 0° |
| s7 | 0.1 % | 0.0 % | 0.0 % | 0.1 % | 0.0 % | 0.0 % | 112° → 112°, 0° |
| s8 | 0.0 % | 0.0 % | 0.0 % | 4.7 % | 2.3 % | 2.2 % | 32° → 32°, 0° |
| s9 | 7.8 % | 2.6 % | 2.1 % | 0.7 % | 1.1 % | 5.6 % | 154° → 154°, 0° |
| s10 | 0.0 % | 0.0 % | 0.2 % | 0.3 % | 0.3 % | 0.2 % | 120° → 120°, 0° |
| s11 | 0.5 % | 1.7 % | 2.2 % | 3.7 % | 1.2 % | 0.2 % | 32° → 31°, 0° |
| s12 | 6.6 % | 9.6 % | 6.5 % | 4.0 % | 2.6 % | 2.6 % | 236° → 219°, 17° |

## Kontrola metriky (T1, 9. 11.)

- **Tahle tabulka je šum opakování:** `p81/base` je `main` s P77 (`bab71daf`), `p77/after` je tentýž vzhled nafocený v P77. Medián 0,5 % – stejný kód nafocený dvakrát se liší o desetiny procenta.
- **Změna P77** (`--a evals/play/p77/base --b evals/play/p77/after`): medián desktop-1play **2,9 %**, medián všech snímků 2,3 %, nejvíc s12 9,7 % a s9 5,1 %. Splňuje kontrolu „P77 < 6 %“ – metrika potvrzuje, že P77 změnila jen detail.
- **Šum, se kterým počítat:** s12 (sníh) má i při opakování 6–10 % a jeho odstín středu skáče o 17° (střed je skoro bílý sníh, odstín bez sytosti je nestabilní); s9 (déšť) a s1 telefon kolem 5–8 %. Brána T3/T7 (medián ≥ 25 %) je nad šumem s rezervou; posun odstínu s12 číst opatrně.
