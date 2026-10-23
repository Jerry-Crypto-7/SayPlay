# P58B – čtečka vět vybere správnou hru

Plán `plans/P58B-ctecka-a-typ-hry-2026-10-23.md` (necommitovaný). Větev `features/P58B-ctecka-a-typ-hry-2026-10-23` z `main` `1a3306eb`.

## Zapečetěná sada (T1)

- **Ladí se výhradně na dev:** `p55/holdout.json`, `p56a/holdout.json` (obě otevřené, mají `holdout-opened.json`) a `p30/dev.json`.
- **`holdout.json`** – 80 vět, které 23. 10. napsal Codex (`codex exec`, `model_reasoning_effort=high`, sandbox jen pro čtení, prázdný dočasný adresář jen se zadáním). Kód, plány ani sady neviděl; dostal 25 jednovětých popisů režimů 19 žánrů z pohledu hráče, seznam 18 světů, tvar záznamu a pokyn psát jako hráč 13+ (slang, opisy, bez jmen žánrů a her, hrdina a protivník konkrétní, asi čtvrtina vět bez hrdiny). Dvě volání: 76 cílů (4 na žánr, režimy arény, plavby, úkolu a načasování rozepsané) a 28 pastí (`lure` = kam věta láká, `genre` = správný žánr, u 8–10 `null`, lákavý a správný žánr se liší i před tečkou).
- **Druhý soudce:** Opus 5.5 přes `claude -p --safe-mode` bez nástrojů, v prázdném adresáři, předplatné (ceníkem 0,23 USD). Dostal tytéž popisy žánrů a všech 104 vět promíchaných, **bez** štítku žánru a rodiny; sám určil žánr a potvrdil hrdinu, protivníka, věc a svět. Rozpor = jiný režim než u autora, nebo štítky rolí neseděly. **Rozporů 0 ze 104** – nic se nevyřadilo kvůli sporu.
- **Výběr 80 ze 104** (bez čtení vět): 3 cíle na žánr se střídáním režimů, pak 3 navíc z dalších žánrů (běžec, plošinovka, aréna) = 60; pasti 6 bez žánru (poměr autora 9/28) a 14 se žánrem, obojí střídavě po lákavých žánrech = 20 (14 lákavých žánrů). Id `s01`–`s60` cíle, `s61`–`s80` pasti.
- Soubor zapsal skript rovnou do repozitáře; v relaci věty nikdo nečetl. **SHA-256 nad LF bajty: `578463714c9cee6540eb7c4755a68ecfbb883905388ad741c3f0648058c117e8`**.
- `__tests__/holdout.test.ts` hlídá otisk, počty (každý z 19 žánrů ≥ 3 – plán píše 18, `GENRES` jich má 19), tvar štítků a nulový průnik (po `normalizeSentence`, na výstup jen id) se všemi sadami vět v `p30/`, `p55/`, `p56a/`, `p58a/` (ta přibude sloučením P58A) a s dalšími sadami, na kterých se ladilo (p43, p45, p52, p54c, demand). Otevře ji jen měření brány v T8, jednou: `openSealedOnce` (`seal.ts`, pečeť P55).

## Srovnání čteček (T3)

Majitel 23. 10. zúžil srovnání na dva modely: `opus-5.5@anthropic` (Anthropic Messages API, `claude-opus-5-5`, úsilí `low`) a `astra@openai` (OpenAI API, `gpt-6-astra`, úsilí `low`). Klíč Anthropic ani po opravě souboru neprošel (400), proto **rozhodnutí majitele 23. 10.: měří se jen astra**, Opus ne. Měří se z lokálního PC k poskytovateli.

- **Ceny v měřidle:** Opus 5.5 4/20 USD za Mtok, zápis cache 1,25×, čtení 0,05× (systémový prompt nese bod cache). Astra 10/50 USD za Mtok podle ceníkových přehledů (oficiální stránka OpenAI neověřena); automatickou slevu OpenAI za cache produktová cesta nevidí, takže útrata astry je horní mez.
- **Zkouška 23. 10., 3 věty (1 cíl a 1 past z `p56a/holdout.json`, 1 věta `p30/dev.json`), `--cap-usd 1`:** astra přečetla 3/3 (cíl i past správně), 4,7 s medián, 6,9 s max, ~1 930 vstupních a 87–227 výstupních tokenů, **0,081 USD**. Opus 3× odmítnut 400 – klíč majitele (`sk-ant-usr…`) je vázaný na uživatele a API chce hlavičku `anthropic-workspace-id`; výchozí pracovní prostor ID nemá. Odmítnutá volání Anthropic neúčtuje, měřidlo je přesto započetlo nejhorším případem (0,114 USD). Skutečná útrata zkoušky ≤ 0,081 USD.
- **Srovnání se slovníkem** počítá měřidlo samo a zdarma (`dictionaryOf`, klíč `dictionary` ve výstupu): tytéž přečtené věty jen přes `classifyGenre(věta, null)`.

### Výsledek na dev, 23. 10. (`compare-dev.json`, commit měřidla `bf964e7e`, prompt `beda31d4ee60c875`)

220 vět: `p56a/holdout` (60 cílů + 20 pastí), `p55/holdout` (60 + 20), `p30/dev` (60 vět bez štítku – jen rychlost a cena). Žádná neplatná odpověď, žádná chyba.

| | žánr cílů | pasti mimo lákavý žánr | p50 | p95 | cena za větu |
|---|---|---|---|---|---|
| **astra** (čtení + dnešní `classifyGenre`) | **118/120** | **34/40** | 3,3 s | 6,4 s | 0,027 USD |
| jen slovník (dnešní rychlá hra, `classifyGenre(věta, null)`) | 45/120 | 29/40 | – | – | 0 |

- **Po sadách:** `p56a` astra 58/60 a pasti 16/20, slovník 25/60 a 11/20; `p55` astra 60/60 a 18/20, slovník 20/60 a 18/20; `p30/dev` p50 3,0 s, p95 4,9 s. Režim sedí všude, kde sedí žánr (118/120). Role v `p56a`: hrdina 77/80, protivník 75/80.
- **Rychlost:** žádná z 220 vět pod 1 000 ms; nejrychlejší 2,1 s, nejpomalejší 9,1 s. Odpověď je celá naráz, takže první bajt = celek.
- **Rychleji astra nejde:** `reasoning_effort` `none` i `minimal` API odmítne (400, povolené jen `low`, `medium`, `high`, `xhigh`) a i odpověď o 4 tokenech trvá při `low` ~1 s.
- **Tokeny a cena:** ~1 918 vstupních a ~154 výstupních tokenů na větu. Cena je horní mez – slevu OpenAI za cache měřidlo nevidí.

**Rozhodnutí (T3):** čtečka je **astra a čte jen pro AI verzi** na pozadí. Rychlá hra (do 2 s) na čtení nečeká a dál vybírá slovník s pravidlem z T5; zálohou čtení je slovník. Brána pro rychlou hru se v T8 zapíše zvlášť (cíl plánu). Důvod: p95 6,4 s je šestkrát nad hranicí 1 000 ms a nižší úsilí model nedovolí.

**Data pro T5** (dnešní pravidlo „slovník přebije čtení, když slyší nový žánr“):
- **Slovník přebil správné čtení 2×:** `p56a/s02` (čtení `merge`, hra `defense`), `p55/h78` (čtení `voyage.race`, hra `whack`). Samotné čtení by mělo cíle 119/120.
- **Čtení řeklo „nic nesedí“ (žánr `null`) a slovník pak zvolil lákavý žánr 4×:** `p56a/s68` (`rhythm`), `s74` (`voyage.race`), `s80` (`shooter`), `p55/h79` (`hop`). U 7 dalších pastí s `null` padl slovník mimo lákavý žánr náhodou (`s62`, `s76`, `s78`, `h64`, `h67`, `h71`, `h73`).
- **Chyba samotného čtení 2×:** `p56a/s08` (farmář stříká hadicí na vrány „než se dostanou ke kukuřici“ – čtení `defense`, štítek `shooter`), `p56a/s65` (karetní souboj – čtení `duel`, tedy lákavý žánr).

**Útrata T3:** běh 5,92 USD (strop 12) + zkouška 3 vět 0,081 USD + sonda bez uvažování ~0 USD (7 vět odmítnutých 400, které OpenAI neúčtuje – měřidlo si je přesto rezervovalo nejhorším případem 0,61 USD – a 3 drobná volání). Celkem T3 ~6,0 USD.

## Slovník × čtení (T5)

**Pravidlo** (`classifyGenre`): rozhoduje platný žánr čtení, který hraje. Slovník rozhodne jen když čtení chybí nebo je neplatné, když jeho žánr je `null` nebo nehraje, nebo když si čtení není jisté – nové pole schématu `sure: false` („dva řádky žánru sedí zhruba stejně nebo hádám“) – a slovník něco slyšel. Pravidlo P56A T5 (slovník rozhodne, kdykoli první slyší nový žánr P54C) zrušeno.

- **Offline na čteních T3** (`compare-dev.json`, pole `sure` ještě nemají = jistá): cíle 118 → **119/120**, pasti 34 → **36/40**. Opravené `p56a/s02` (merge), `p55/h78` a `h79` (už ne nový žánr). Všechny 4 případy P56A s gpt-oss-20b (s02, s03, s09, s12) teď hrají správný žánr.
- **Živě 23. 10.** (`compare-dev-t5.json`, astra, prompt `37da73059b148b9e` s řádkem `sure`, p56a + p55 holdout, 160 vět, `--cap-usd 6`): cíle **118/120** (T3 118), pasti **35/40** (T3 34), role hrdina 77/80, protivník 76/80, 0 neplatných, p50 2,9 s, p95 5,4 s. **Žádný žánr cílů neklesl o víc než 1 větu:** úkol 4 → 3.
- **`sure: false` padlo 12×:** 10 pastí (8 z nich se žánrem `null`) a 2 cíle. Se žánrem a nejisté byly 4 věty a slovník u nich rozhodl: `s04` stejně jako čtení, `p55/h64` jinak, ale obojí mimo nový žánr, **`s39` cíl ztracen** (čtení `quest.spatial` správně, slovník `arena.escape`) a **`s71` past spadla na lákavý `arena.escape`** (čtení `quest.spatial`). Bez větve `sure` by tatáž čtení dala 119/120 a 36/40.
- **Data pro T6:** nejistota astry zatím slovníku nepomohla ani jednou (0 zisků, 2 ztráty na 160 větách). Prompt v T6 ať `sure` buď zpřesní, nebo se větev zruší – rozhodne dev s novým promptem.
- **Skládání hry přehodí žánr čtení** (zjištěno pinem v `compose.test.ts`): se stejnými čteními T3 dává `draftGameSpecWithMeta` na p56a jen 50/60 (před T5 49/60), `classifyGenre` 59/60 – úkol **T5a** v plánu. Na p55 60/60.

**Útrata T5:** 4,40 USD (strop 6).
