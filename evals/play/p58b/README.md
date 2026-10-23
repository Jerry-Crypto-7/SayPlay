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

Majitel 23. 10. zúžil srovnání na dva modely: `opus-5.5@anthropic` (Anthropic Messages API, `claude-opus-5-5`, úsilí `low`) a `astra@openai` (OpenAI API, `gpt-6-astra`, úsilí `low`). Měří se z lokálního PC k poskytovateli.

- **Ceny v měřidle:** Opus 5.5 4/20 USD za Mtok, zápis cache 1,25×, čtení 0,05× (systémový prompt nese bod cache). Astra 10/50 USD za Mtok podle ceníkových přehledů (oficiální stránka OpenAI neověřena); automatickou slevu OpenAI za cache produktová cesta nevidí, takže útrata astry je horní mez.
- **Zkouška 23. 10., 3 věty (1 cíl a 1 past z `p56a/holdout.json`, 1 věta `p30/dev.json`), `--cap-usd 1`:** astra přečetla 3/3 (cíl i past správně), 4,7 s medián, 6,9 s max, ~1 930 vstupních a 87–227 výstupních tokenů, **0,081 USD**. Opus 3× odmítnut 400 – klíč majitele (`sk-ant-usr…`) je vázaný na uživatele a API chce hlavičku `anthropic-workspace-id`; výchozí pracovní prostor ID nemá. Odmítnutá volání Anthropic neúčtuje, měřidlo je přesto započetlo nejhorším případem (0,114 USD). Skutečná útrata zkoušky ≤ 0,081 USD.
