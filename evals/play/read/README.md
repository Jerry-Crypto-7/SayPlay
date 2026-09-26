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

## Záloha režiséra (T9)

Měřeno 26. 9. 2026, kompaktní režisér (`direct(…, { compact: true })`) přes lokální
llama.cpp, bez robota (měří se model, ne publikace), strop volání 120 s. Volné VRAM
~15 GB (zbytek držely jiné procesy). Surová data: `evals/play/local-director.json`.

| Model | Sada | Platná hra | p50 / p90 | `read` | `drawn` | draft ze slov `read` / `drawn` |
|---|---|---|---|---|---|---|
| **gpt-oss-20b** MXFP4 | korpus 30 | **28/30** | **4,5 / 11,1 s** | 0,800 | 0,755 | 0,755 / 0,718 |
| **gpt-oss-20b** MXFP4 | judge-10 | **10/10** | **5,6 / 10,8 s** | **0,676** | **0,649** | 0,514 / 0,514 |
| Qwen3.6-35B-A3B UD-IQ3_S | korpus 30 | 23/30 | 30,8 / 38,5 s | 0,818 | 0,773 | 0,755 / 0,718 |
| Qwen3.6-35B-A3B UD-IQ3_S | judge-10 | 6/10 | 36,1 / 55,4 s | 0,649 | 0,622 | 0,514 / 0,514 |

Neplatné odpovědi jsou u obou jen `MALFORMED` (JSON mimo kontrakt); pak zůstane draft ze slov.

**Volba: gpt-oss-20b** (výchozí `-Fallback` v `ops/llm/start.ps1`). Je 6–7× rychlejší,
dává víc platných her a na judge-10 i vyšší `read` a `drawn`. Qwen má na korpusu o 0,018
lepší `read`, ale za cenu 30 s na větu a čtvrtiny neplatných odpovědí – jako záloha
zaseknutého předplatného by čekání jen prodloužil.

Spuštění (`evals/play/local-director.cmd`, model v `%P29B_FALLBACK%`):

```
set P29B_FALLBACK=gpt-oss-20b
node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/local-director.cmd
```

## Výhrady (odhad, ne měření)

- Srovnání zálohy s živým předplatným (gpt-6-astra) na stejné sadě tu neběželo. Číslo
  judge-10 0,676 říká jen, že záloha je lepší než draft ze slov (0,514), ne jak blízko je předplatnému.

- Klíčová slova mají na štítcích poptávky náskok, který nemusí být celý zásluhou: slovník
  draftu se ladil nad podobnými větami. Čtečka tu soutěží na hřišti klíčových slov.
- judge-10 měří čtečku jen přes ovládání. Plný draft ze čtení (T4) může číslo posunout
  oběma směry; do výchozího zapnutí ho pustí jen nové měření podle stejného pravidla.
- Jde o jeden model 4B. Větší čtečka by při 1,2 s na větu p95 pravidla nesplnila tím spíš.
