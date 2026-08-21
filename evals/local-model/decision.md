# Rozhodnutí o modelu v prohlížeči (P11 T6)

Zdroj čísel: `evals/local-model/grammar-report.json` a `grammar-raw.json`,
adaptér `nvidia/ampere`, prvních 40 vět z `evals/corpus-v3`. Syrové odpovědi jsou
v archivu celé, takže se dá cokoli z toho přepočítat bez opakování běhu.

**Běhy jsou dva a nesmí se míchat.** Oba jsou nad týmž korpusem i strojem:

| Běh | Kdy | Co měřil | `schemaValid` |
|---|---|---|---|
| **Základní** | 20. 8. 2026 **18:57 UTC** | jen model, rozpoznávač tvarů ještě neexistoval | **0** |
| **T7** | 20. 8. 2026 **19:53 UTC** | produkční pořadí: rozpoznávač první, model na zbytek | **0,375** |

Soubory na disku nesou **T7 běh**; základní běh je v historii gitu u commitu
`410cff1`. Sekce 2 až 6 mluví o základním běhu, sekce 7 o T7.

## 1. Vybraný model

| Větev z `detectRuntime()` | Váhy | Kde je to napsané |
|---|---|---|
| `large` | `Qwen3-1.7B-q4f16_1-MLC` | `src/model/local/engine.ts` |
| `small` | `Qwen3-0.6B-q4f16_1-MLC` | tamtéž |
| `cloud`, `none` | žádné — model se v prohlížeči nespouští | tamtéž |

Měřidlo si jméno modelu, strop tokenů i svázaný tvar bere z téhož souboru, takže
naměřené číslo platí o tom, co doopravdy poběží uživateli.

## 2. Co naměřil základní běh (jen model)

| Veličina | Hodnota |
|---|---|
| `attempts` | 40 |
| `schemaValid` | **0** |
| `fulfilled` / `declined` | 0 / 0 |
| `invalid` (rozpársováno, neprošlo schématem) | 28 |
| `unparsable` (nedalo se rozpársovat) | 12 |
| `truncated` (došel strop 1400 tokenů) | 12 |
| `crashes` | 0 |
| `bug807Reproduced` | `false` |
| `medianLatencyMs` | 36 694 (~37 s na větu) |

Chyba `mlc-ai/web-llm#807` se **nereprodukovala** — model ani jednou nespadl,
takže se běh na 0.6B podle zadání T5 vůbec nespouštěl.

## 3. Proč je `schemaValid` nula — a co to NEznamená

Neznamená to, že malý model neumí napsat produkční IR. **27 z 28
rozpársovaných emisí selhalo na jediném poli:** `sim.collisionAabb` (dvacátá
osmá k tomu ještě vnořila `look` dovnitř `sim`). Zbylých 12 se neusekává
významem, ale stropem: dojely na 1400 tokenech uprostřed dokumentu.

Nad archivem se to dá dopočítat, a je to změřené v
`evals/local-model/__tests__/aabb-repair.test.ts`: když se `collisionAabb`
**odvodí** z toho, co model napsal (soket, na kterém entita stojí), pak

- **27 z 28** projde produkčním schématem,
- **12 z 40 dojde až k certifikaci** — svět se postaví, odkazy sedí a svědek
  dojde do výhry,
- z ostatních padá 9 na osiřelém odkazu a 6 na nepodporovaném povrchu.

Model tedy není o kus vedle, je o **jedno odvoditelné pole** vedle. To je
naměřený nález, ne odhad, a je to zdaleka největší jednotlivá páka, kterou tenhle
projekt zatím naměřil.

## 4. Rozhodnutí

**Deterministický rozpoznávač tvarů vět (T7) je aktivní a je to hlavní cesta.**
Práh v AC T6 je `schemaValid ≥ 0,8`; naměřeno je 0, tedy hluboko pod ním. Pořadí
v `src/model/local/emit.ts` je proto: nejdřív rozpoznávač, model až když věta
není poznaná — a `null` z rozpoznávače není chyba, je to předání slova modelu.

Rozhoduje o tom ještě druhé číslo, na které se AC neptá: **medián 37 sekund na
větu.** Slib „do dvou sekund se staví svět" model sám o sobě splnit nemůže, ať
by psal jakkoli dobře. Rozpoznávač odpovídá bez GPU a okamžitě; model je tím
pádem doplněk pro věty mimo rozpoznané tvary, ne první housle.

## 5. Měření je reprodukovatelné — naměřeno, ne předpokládáno

Běh se pustil dvakrát za sebou nad týmž kódem (18:57 a 19:34 UTC, tentýž stroj).
**Všech 28 rozpársovatelných odpovědí přišlo bajt po bajtu stejně**, a s nimi
i každá klasifikace: `git diff` nad reportem a archivem ukazuje jediné dva
rozdíly, časové razítko a medián latence (36 694 vs. 36 735 ms).

Není to samozřejmost a nebylo to zadané: znamená to, že `temperature: 0` a
`seed: 1` ve WebLLM drží slovo, takže se dá o modelu tvrdit něco, co se dá
zopakovat. Pro projekt postavený na determinismu je to silnější doklad než
kterékoli číslo výš.

## 6. Co z toho plyne dál — dvě naměřené páky

1. **Odvodit `collisionAabb` na straně systému.** Naměřeno výš: 0 → 12 ze 40
   certifikovaných světů. Zatím **není postavené**; pozor na to, že se to musí
   dít ve sdíleném řetězu (`src/model/certify.ts`), jinak by prohlížeč přijímal
   světy, které server odmítá. Volba velikosti obálky (systémové 1×1) je věcné
   rozhodnutí o obsahu, ne technikálie.
2. **Zvednout strop odpovědi.** 12 ze 40 pokusů skončilo useknutím na 1400
   tokenech. Cena je latence — useknuté pokusy už teď běžely ~53 s proti mediánu
   37 s.

Ani jedna z nich není součástí T6 a ani jedna se nesmí započítat do žádného
tvrzení, dokud nebude naměřená ze živého běhu, ne z archivu.

## 7. Co naměřil běh T7 — rozpoznávač první, model na zbytek

Běh **20. 8. 2026 19:53 UTC**, tentýž stroj a tentýž korpus, ale v pořadí, které
produkt doopravdy používá (`src/model/local/emit.ts`): nejdřív deterministický
rozpoznávač tvarů, model až na věty, které nepoznal.

| Veličina | Základní běh | Běh T7 |
|---|---|---|
| `attempts` | 40 | 40 |
| `schemaValid` | 0 | **0,375** |
| `fulfilled` | 0 | 15 |
| `shapesHandled` (z toho rozpoznávač) | — | 15 |
| `invalid` | 28 | 17 |
| `unparsable` (z toho `truncated`) | 12 (12) | 8 (8) |
| `medianLatencyMs` (jen model) | 36 694 | 36 704 |

**Přírůstek je 0,375**, práh v AC T7 je 0,15.

**Co to číslo neříká, a je to podstatnější než ono samo:** všech 15 splněných vět
obsloužil rozpoznávač. Model dostal zbylých 25 vět a **ani jednu z nich neposlal
v platném tvaru** (17 neprošlo schématem, 8 se nedalo rozpársovat). Zvednutí
`schemaValid` z 0 na 0,375 tedy neměří, že by se model zlepšil — měří, jakou část
korpusu umí systém obsloužit bez něj. Páky ze sekce 6 tím nezanikají, naopak: pořád
jsou to jediné dvě naměřené cesty, jak zvednout tu část, kde model rozhoduje.

Latence rozpoznávače se do mediánu nepočítá schválně, aby zůstal srovnatelný se
základním během; rozpoznávač odpovídá bez GPU a v řádu milisekund.
