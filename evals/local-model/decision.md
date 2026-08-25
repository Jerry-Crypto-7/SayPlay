# Rozhodnutí o modelu v prohlížeči (P11 T6)

Zdroj čísel: `evals/local-model/grammar-report.json` a `grammar-raw.json`,
adaptér `nvidia/ampere`, prvních 40 vět z `evals/corpus-v3`. Syrové odpovědi jsou
v archivu celé, takže se dá cokoli z toho přepočítat bez opakování běhu.

**Běhů je několik a nesmí se míchat.** Všechny jsou nad týmž korpusem i strojem:

| Běh | Kdy | Co měřil | `schemaValid` |
|---|---|---|---|
| **Základní** | 20. 8. 2026 **18:57 UTC** | jen model, rozpoznávač tvarů ještě neexistoval | **0** |
| **T7** | 20. 8. 2026 **19:53 UTC** | produkční pořadí: rozpoznávač první, model na zbytek | **0,375** |
| **A** | 25. 8. 2026 | totéž s **kompaktním** příkladem v promptu — vráceno, viz §8.2 | 0,425 |
| **B** | 25. 8. 2026 **10:53 UTC** | totéž s odsazeným příkladem, tedy shodně s kódem, + rozpad latence | **0,400** |

**Soubory na disku nesou běh B.** Starší běhy jsou v historii gitu: základní
u `410cff1`, T7 u `b937353`. Běh A se nezachoval jinak než čísly v §8.2, protože
konfigurace, kterou měřil, se vrátila.

Sekce 2 až 6 mluví o základním běhu, sekce 7 o T7, sekce 8 o obou z 25. 8.
**Než odsud budeš citovat číslo, přečti §8.3 — dvě čísla v sekci 3 jsou
zastaralá.**

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

> ⚠ **Čísla „27 z 28" a „12 ze 40" v téhle sekci jsou zastaralá.** Nad dnešním
> kódem a týmž archivem vychází **16 z 25 a 8 dohraných** (přeměřeno 25. 8. 2026,
> §8.3). Posunulo je schéma a snížení, ne archiv. Závěr sekce platí beze změny,
> jen ta dvě čísla se necitují.

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

## 8. Kam těch ~37 sekund teče — rozpad latence (25. 8. 2026)

Do téhle sekce patří tři věci: naměřený rozpad latence, **vyvrácená hypotéza**
o vynuceném tvaru, a **vyvrácený zásah**, který se zkusil a musel se vrátit.

Dva běhy téhož dne, tentýž stroj (`nvidia/ampere`), tentýž korpus. Rozpad měří
knihovna zevnitř dekódovací smyčky (`usage.extra`, zapnuto
`extra_body.enable_latency_breakdown`), ne stopky kolem volání — vlastní stopky
vidí jen součet.

### 8.1 Kde je úzké hrdlo (a kde není)

| Veličina | Naměřeno |
|---|---|
| medián celého požadavku | 40 814 ms |
| medián tokenů v odpovědi | 959 |
| medián tokenů v zadání | 2 729 |
| rychlost psaní | 24,9 tok/s |
| **podíl režie mezi tokeny** | **0,814** |
| z toho vzorkování tokenu | **0,804** |
| z toho vynucený tvar odpovědi | **0,009** |
| nepojmenovaný zbytek | 0,001 |

**Model sám je 18,6 % běhu.** Zbytek je obsluha kolem něj. Přepočteno: model
píše rychlostí ~126 tok/s, ale na každý token se navrch platí **~34 ms za
vzorkování** — WebLLM stahuje logity celého slovníku (Qwen3 má 151 936 tokenů)
z GPU do paměti procesoru a čeká na synchronizaci, jednou za každý napsaný token.

**Vynucený tvar odpovědi stojí 0,9 % a není co na něm zlevňovat.** Hypotéza, že
za pomalostí stojí kontrola JSON schématu při každém tokenu, je tímhle vyvrácená
— zapisuje se sem proto, aby se nezkoušela znovu. Totéž platí pro zkracování
zadání: 2 729 tokenů prefillu se vejde do 18,6 %, ve kterých je i celý model.

**Co z toho plyne pro rozhodnutí o zapojení modelu:** ~37 s na emisi není vlastnost
modelu ani našeho promptu, je to vlastnost dekódovací smyčky WebLLM 0.2.84, a
z tohohle repozitáře se nedá opravit bez zásahu do knihovny. Menší model zkrátí
jen těch 18,6 %.

### 8.2 Zkompaktnění příkladu v promptu — zkusilo se, uškodilo, vráceno

Úvaha: model kopíruje formát toho, co vidí, a naměřeně bylo **52,5 % znaků jeho
odpovědi** jen odsazení (60 361 znaků syrově proti 28 655 týchž dokumentů
kompaktně, 17 rozpársovatelných odpovědí běhu T7). Kompaktní příklad měl odpověď
zkrátit a s ní i čas.

Zkrátil. A rozbil strukturu emise:

| | příklad odsazený | příklad kompaktní |
|---|---|---|
| medián latence | 40 814 ms | **24 270 ms** |
| medián tokenů odpovědi | 959 | **626** |
| useknuto na stropu 1400 | 8 | **5** |
| emise padají na | **jediném poli** `sim.collisionAabb` (16 ze 17) | `collisionAabb` **a navíc** `sim.grid` (15×), `look.materialRoles` (5×) |
| po doplnění `collisionAabb` platných | **16** | **0** |
| z toho dojde do výhry | **8** | **0** |

**Zrychlení a ztráta kvality jsou táž událost:** model psal rychleji, protože psal
míň — a to, co vynechal, byla povinná pole. Odsazený příklad mu tedy neslouží jako
vzor formátu, ale jako **seznam polí, který si projde po řádcích**; na jednom
řádku o 1 800 znacích tu oporu ztratí.

Cena je páka ze sekce 6, tedy ta jediná, kterou tenhle projekt na model naměřil.
Vyměnit ji za 12 sekund je špatný obchod, takže **`src/model/prompt.ts` je vrácený
na odsazený příklad** a `src/model/__tests__/prompt.test.ts` to drží asercí —
vada po téhle zkratce totiž není vidět ani na zprávě, ani na světě, ukáže se až
po třinácti minutách na GPU.

**Kontrolní měření, aby se ztráta nepřipsala nesprávné příčině:** táž oprava
`collisionAabb` puštěná nad **starým** archivem (běh 20. 8.) dnešním kódem dává
16 platných a 8 dohraných, tedy funguje dál. Rozdíl tedy nezpůsobil posun kódu
mezi srpnovými daty, ale ta změna promptu.

### 8.3 Dvě čísla v tomhle dokumentu jsou zastaralá

- **„27 z 28" a „12 ze 40" ze sekce 3 už nad dnešním kódem neplatí.** Přeměřeno
  25. 8. 2026 nad týmž archivem: **16 z 25 platných a 8 dohraných**. Posunulo to
  schéma a snížení mezi 20. a 25. 8., ne archiv — ten je bitově týž. Směr, kvůli
  kterému sekce 3 vznikla, platí beze změny: doplnění jednoho odvozeného pole
  posune emise z „neplatná" na „certifikovaná". **Cituj 16 z 25, ne 27 z 28.**
- **Rozdělení rozpoznávač / model je dnes 16 / 24, ne 15 / 25.** Rozpoznávač se
  po měření dvakrát změnil (commity z 21. 8.). `schemaValid` proto **není** mezi
  srpnovým a srpnovým během porovnatelné head-to-head; porovnatelné jsou
  veličiny nad odpověďmi modelu (tokeny, latence, useknutí, na čem padají).
- **Model sám dodal 0 platných emisí i dnes** (16 splněných = 16 od rozpoznávače).
  Jediná výjimka za celé měření je `P024` v kompaktním běhu, tedy v konfiguraci,
  která se vrátila.

### 8.4 Běhy 25. 8. 2026

| Běh | Prompt | `schemaValid` | medián | Artefakt |
|---|---|---|---|---|
| A | kompaktní příklad | 0,425 | 24 270 ms | jen v tomhle zápisu, vráceno |
| B | odsazený příklad (shodný s kódem) | 0,400 | 40 814 ms | **soubory na disku nesou tenhle** |

Medián běhu B je o 11 % vyšší než u srpnového běhu nad týmž promptem (40 814 proti
36 704 ms). Rozdíl se nevysvětluje — je to kolísání stroje mezi běhy, ne naměřený
efekt, a nesmí se z něj nic vyvozovat. Rozpad latence v 8.1 je na něm nezávislý:
jsou to podíly téhož běhu, ne srovnání dvou.
