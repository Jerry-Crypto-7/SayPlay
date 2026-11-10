# P83B T5 – AI verze naživo, 15 nových vět

**Datum:** 10. 11. 2026, 18:47. Místní `next start` (:3212, build `fb45e5e7`), produkční cesta režiséra: `gpt-6-astra` přes placené OpenAI API, `VERCEL_ENV=production`, strop útraty 6,38 USD (= 9 − 2,61 USD). Klient jako stránka: POST věty, dotazy na upgrade každé 2 s, strop 48 s.

## Výsledek: neměřeno – účet OpenAI nemá kredit

| Kritérium | Cíl | Naměřeno |
|---|---|---|
| AI verze do 45 s | ≥ 11/15 | **0/15** |
| Chybová hláška | 0/15 | 0/15 (viz níže) |
| Medián času do konce | – | 4,0 s (konec = `draft-final MODEL_UNAVAILABLE`) |
| Útrata | – | 0 USD (45 volání, všechna 429, žádné tokeny) |

**Fakta.** Všech 45 volání (čtení i režie, 3 na větu) vrátilo HTTP 429. Jedno ruční volání týmž klíčem vrátilo `type: insufficient_quota`, `code: credit_balance_exhausted`: „You have no credits remaining.“ Klíč je produkční (stažený `vercel env pull`), takže AI verze teď nevzniká ani na nasazeném demu.

**Chybová hláška 0/15** platí jen pro odpověď API: všech 15 skončilo `draft-final` s důvodem `MODEL_UNAVAILABLE`, který banner od T3 (`5496ba6b`) ukáže jako „The quick version is the one to play.“ – drží to testy T3, stránku v prohlížeči jsem při tomto běhu neviděl.

**Co se ověřit dalo:** zúžené schéma (`fb45e5e7`) opravdu odchází – režie posílá 21 753 znaků schématu místo ~375 tis.

## Věty

| # | Skupina | Věta | Konec |
|---|---|---|---|
| 1 | hra | A frog hops across lily pads to catch fireflies before sunset | 12,2 s |
| 2 | hra | Steer a hot air balloon between storm clouds and pick up lost kites | 4,3 s |
| 3 | hra | A penguin slides down an icy hill dodging snowmen to reach the fish market | 7,2 s |
| 4 | hra | Two rival chefs race to flip twenty pancakes before the kitchen bell rings | 6,9 s |
| 5 | hra | A firefighter climbs a burning tower and rescues four cats from the windows | 4,3 s |
| 6 | mimo žánr | My grandmother waters her tomato garden every morning while humming old songs | 4,0 s |
| 7 | mimo žánr | The night train to Vienna is late and everyone is reading by lamplight | 3,5 s |
| 8 | mimo žánr | A lighthouse keeper writes letters to a sailor who never answers | 3,5 s |
| 9 | mimo žánr | Rain falls on a quiet city and the streetlights flicker one by one | 4,1 s |
| 10 | mimo žánr | A violinist practices scales in an empty concert hall | 2,7 s |
| 11 | záludná | Do not touch the red tiles, only the blue ones, and reach the exit in thirty seconds | 3,4 s |
| 12 | záludná | A ghost who is afraid of people has to sneak past seven sleeping children to get home | 4,7 s |
| 13 | záludná | Build a bridge from exactly five planks so the toy truck can cross the river | 3,2 s |
| 14 | záludná | The floor is lava, the ceiling is ice, and a cat must cross the living room | 3,5 s |
| 15 | záludná | Catch every falling apple except the rotten ones, and never let the basket overflow | 2,9 s |

Všech 15 vět je dál nových: žádná AI verze nevznikla, cache režiséra je nezná.

## Co dál

Po doplnění kreditu OpenAI pustit tytéž věty znovu (`launch.mjs <strop> t5b`, `run.mjs t5b 48 t5-sentences.txt`). Zbývá 6,39 USD do 9 USD.
