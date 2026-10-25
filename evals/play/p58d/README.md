# P58D T4 – hra od tří sekund na zapečetěné sadě P58B

**Brána nesplněna.** Hra, kterou hráč hraje od příchodu čtení, má žánr věty u **32/60** cílů (brána 48) a pasti obchází u **20/20** (brána 18). Dnešní rychlá hra: 25/60 a 15/20. Všech 28 chybějících cílů je **řetěz mikroher** – ten AI verzi nemá (P56C T10), takže se pro něj čtení nikdy nezaplatí a hra ze čtení nevznikne. U vět, které hrají jednu hru, trefí hra od tří sekund žánr u všech 32 cílů.

## Výsledek (`result.json`)

| | od tří sekund | rychlá hra dnes | brána |
|---|---|---|---|
| cíle se žánrem věty | 32/60 | 25/60 | ≥ 48 |
| pasti mimo lákavý žánr | 20/20 | 15/20 | ≥ 18 |
| věty v řetězu (bez čtení) | 40/80 (28 cílů, 12 pastí) | 40/80 | – |
| hra ze čtení (mezistupeň) | 24 vět | – | – |
| robot vyhraje / nečinný prohraje / replay | 40/40 jedné hry, mezistupně 24/24 | – | každá |

- Mezistupeň nic nezhoršil: 19 vět přešlo ze špatného žánru na správný, 0 opačně; všech 24 prošlo publikací (`publishReadSpec`).
- Čtení dorazí u mezistupňů za p50 3,4 s, max 6,5 s (uložené časy P58B).
- **Kdyby řetěz dostal čtení** (dnes ne – nové placené volání): 60/60 a 20/20. Se čtením by 21 ze 40 vět zůstalo řetězem, rozhodnutí o řetězu by se tedy změnilo u 19.

Rychlá hra 25/60 a 15/20 se shoduje s P58B T8 (`p58b/final.json`, `fast`) – měřidlo staví tutéž hru.

## Jak se měří

```
npx vitest run --config vitest.measure.mts evals/play/p58d/holdout.measure.ts
```

Bez nového volání: čtení jsou uložená z P58B T8 (`p58b/readings/holdout.astra.json`, astra `low`, verze promptu `24ae3babe923814f` – stejná jako dnes). Cesta je produktová: rychlá hra je návrh bez čtení (semínko 1); věta, kterou rozhodnutí o řetězu pošle do řetězu, hraje řetěz; jinak návrh se čtením, a když `playsOtherGenre`, projde `publishReadSpec` na semínkách serveru – publikovaný je mezistupeň. Žánr hry se počítá jako v P58B (`meta.genre` návrhu); past projde, když nehraje lákavý žánr i režim. Řetěz tu robot nehraje, ověřuje ho jeho vlastní publikace.

Sada je otevřená od P58B T8; měřilo se na ní jednou, nic se podle ní neladilo. `__tests__/result.test.ts` přepočítá bránu z řádků proti prahům plánu a ověří, že výsledek i tohle README hlásí verdikt, který z řádků vychází.

## Živá kontrola (`live.json`, `live.mjs`, `live-reading-switch.png`)

Produkční build (`next start`), čtečka astra přes klíč z worktree P58B (do repa ani logu se nedostal), 5 vět z `p30/dev.json` + s002 jako kontrola zdarma.

- Hra ze čtení přišla u **3 z 5** vět: od odeslání **p50 4,98 s, max 8,32 s** (s003 8,3 s se studeným startem, h09 5,0 s, d16 3,2 s). j06 a h02 ji nedostaly – čtení dalo týž žánr nebo hru bez žánru.
- s002 je naživo řetěz – bez AI verze, bez hry ze čtení (souhlasí s měřením).
- Snímek (d16, Pixel 7): přepínač `Quick | Matched | Full detail`, Matched zvýrazněný; `[data-reading="current"]` na stránce jednou, všechny tři popisky viditelné.
- **Útrata 0,147 USD** (5 čtení po ~0,029 USD, z počtu tokenů OpenAI, 10/50 USD za milion), strop 0,50 USD.
- AI verze neproběhla: jedna AI verze s astrou stojí 0,62–0,67 USD (P58B), víc než celý rozpočet. Strop ji odmítl (`MODEL_UNAVAILABLE`), takže návrat AI verze k žánru rychlé hry se ověřit nedal.

## Co kontrola ukázala mimo bránu

- **Strop odmítl AI verzi, hráč čeká navždy.** Odmítnutí stropem server nepamatuje, každé dotazování spustí nový pokus a stránka hry ze čtení hlásí „the full-detail one is on its way“ bez konce.
- **Strop útraty může podhodnotit volání režiséra.** Rezervace předem nepočítá se schématem odpovědi (u režiséra asi 0,32 USD) a kniha útratu ořízne na rezervaci (`src/server/spend-cap.ts:876`). Skutečná cena volání režiséra může být vyšší, než kniha ukáže.
- Hrdina sovy na snímku vypadá jako zmačkaná hnědá krabice – vzhled modelu, mimo P58D.

## Rozhodnutí pro majitele

Brána 48/60 se touto cestou nedá splnit bez nového placeného čtení pro věty v řetězu (dnes polovina sady). Možnosti: (a) zaplatit čtení i pro řetěz (asi 0,03 USD za větu s astrou) a přepnout z řetězu na hru ze čtení vždy – na sadě 60/60 a 20/20; (b) totéž čtení, ale přepnout jen tam, kde by se čtením řetěz nevznikl – 19 ze 40 vět; (c) řetěz nechat a přijmout 32/60.
