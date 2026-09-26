# Čtečka věty proti klíčovým slovům (P29B T3)

Měřeno 26. 9. 2026 nad commitem `ef37e8de`, lokální llama.cpp b11200 na RTX 3090,
čtečka **Qwen3-4B-Instruct-2507 Q5_K_M** (`ops/llm/start.ps1 -Role reader`, port 8791).

## Výsledek

| Co | Čtečka | Klíčová slova |
|---|---|---|
| Třída slovesa, 200 vět poptávky | **117/200 = 0,585** | **145/200 = 0,725** |
| Ovládání, 162 vět s ovládáním | **109/162 = 0,673** | **145/162 = 0,895** |
| judge-10 `read` (řetěz věrnosti) | **0,351** | **0,514** |
| korpus věrnosti `read` (30 vět) | 0,718 | 0,755 |
| Latence p50 / p95, 200 vět | 1 202 / 2 132 ms | – |
| Latence p50 / p95, fidelity běh | 1 173 / 1 529 ms | – |
| Nepřečtené věty | 0 z 200 | – |

**Rozhodnutí podle napsaného pravidla: `off`.** Pravidlo chtělo judge-10 `read` ≥ klíčová
slova + 0,10 a p95 ≤ 1 500 ms. Čtečka je o 0,163 **pod** klíčovými slovy a p95 obě
měření přetáhla. T4–T5 proto dostanou čtení jen za přepínačem vypnutým ve výchozím stavu.

## Jak se to měří

- `measure.ts` pošle každou z 200 vět `evals/play/demand/corpus.json` čtečce a porovná
  s ručním štítkem `verb`: u čtečky první sloveso čtení, u klíčových slov ovládání draftu
  převedené na třídu. Ovládání se soudí jen u 162 vět, jejichž třída v PLAY ovládání má.
- judge-10 a korpus věrnosti jde přes `scripts/play-fidelity.mjs --offline --reader`
  (běh `evals/play/fidelity/runs/p29b-reader.json`). Z čtení se tu bere **jen ovládání**,
  zbytek draftu dál z klíčových slov – draft ze čtení (role, počty) vzniká až v T4.
- Celé měření jde pod jedním serverem a zámkem GPU:

```
node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role reader -Then evals/play/read/measure-all.cmd
```

## Výhrady (odhad, ne měření)

- Klíčová slova mají na štítcích poptávky náskok, který nemusí být celý zásluhou: slovník
  draftu se ladil nad podobnými větami. Čtečka tu soutěží na hřišti klíčových slov.
- judge-10 měří čtečku jen přes ovládání. Plný draft ze čtení (T4) může číslo posunout
  oběma směry; do výchozího zapnutí ho pustí jen nové měření podle stejného pravidla.
- Jde o jeden model 4B. Větší čtečka by při 1,2 s na větu p95 pravidla nesplnila tím spíš.
