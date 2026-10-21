# P55 – zapečetěná sada žánrů (T9, 21. 10. 2026)

**Co to znamená:** klasifikátor žánru se přeučil na vývojové věty. Na nich trefí žánr 59 z 60, na 80 zapečetěných větách nezávislého autora jen 20 z 60 – méně než výchozí stav na vývojových větách před P55 (37/60). Hry samotné jsou v pořádku: všech 80 robot vyhraje, nečinný hráč prohraje a záznam se přehraje stejně. Brány T9 nesplněné; sada se od teď počítá jen jako vývojová a nic se podle ní neladilo.

Měřeno `npx vitest run --config vitest.measure.mts evals/play/p55/holdout.measure.ts` nad `cae3717f`, jednou (`holdout-opened.json`). Cesta jako v produkci bez modelu: klasifikátor a rychlý návrh na semínku 1, pak robot ověřovače. Řádky v `final.json` (jen id, věty se nevypisují).

## Výsledek

| Brána | Výsledek | Cíl | |
|---|---|---|---|
| Cílové věty hrají svůj žánr | **20/60 = 0,33** | ≥ 48/60 | ❌ |
| – pruhové (catch, whack, defense, slice) | **13/32** | ≥ 24/32 | ❌ |
| Pasti zůstanou mimo nový žánr | 18/20 | ≥ 19/20 | ❌ |
| Hratelné (robot vyhraje) | 80/80 | 80/80 | ✅ |
| Výhra za 30–90 s | 75/80 | ≥ 76/80 | ❌ |
| Nečinný prohraje | 80/80 | – | ✅ |
| Přehrání záznamu sedí | 80/80 | – | ✅ |

Po žánrech (trefa / vět): catch 4/8, whack 2/8, defense 3/8, slice 4/8, hop 2/7, crowd 2/7, merge 1/7, push 2/7. Minuté věty padají hlavně do `arena.collect` (14×), `voyage.race` (8×) a `runner.default` (7×) – tedy do obecných her, ne do špatného nového žánru.

- **Pasti:** `h78` skončila ve `whack.default`, `h79` v `hop.default`.
- **Délka mimo 30–90 s:** `h12` (`voyage.race`, 28 s), `h68` (`arena.collect`, 22 s), `h70` a `h74` (`throw.default`, 14 s), `h72` (`voyage.race`, 28 s). Žádná z nich není pruhová hra – vrstva událostí P55 délku nezměnila.

## Proti vývojovým větám

| Sada | Cílové věty | Pruhové |
|---|---|---|
| p54c holdout-opened před P55 (`baseline.md`) | 37/60 | 14/32 |
| tatáž sada po T3–T4 (`dev-result.md`) | 59/60 | 32/32 |
| **zapečetěná P55** | **20/60** | **13/32** |

## Co z toho plyne (odvozeno)

- **Rodiny opisů z T3–T4 se nepřenáší.** Na větách, podle kterých vznikly, dávají skoro 100 %, na nových větách téhož zadání třetinu. To je odpověď na otázku plánu „jestli 0,80 jde bez LLM vůbec“: s regexy po rodinách ne.
- **Další krok je žánr z rychlého LLM** (Groq gpt-oss) pro první hru, jak plán předpokládal pro tento případ. Závisí na klíčích z P30A.
- **Vrstva událostí (linie B) tím není dotčená:** když věta pruhový žánr trefí, hra je podle T8 hustší a vyhrává slepý soud 6/6.
