# P63 – hra po čtení hraje, co věta říká

## Zapečetěná sada

`holdout.json`: 24 nových anglických vět (8 sloveso mimo knihovnu, 8 s počtem v cíli, 8 obecných), napsané 27. 10. 2026 před první změnou kódu P63. SHA-256 nad LF bajty:

`e03e39a08c2a3e4ba2ea98054ce367b08e2ffcd9f66dc815d92222740538051b`

Otevře se jednou v T6 (`holdout-opened.json`). Nic se podle ní neladí. Věta p07 byla před zapečetěním vyměněna – původní („a janitor mops…“) se podobala příkladu v promptu čtečky.

## Čtení pro diagnózu (T1)

`read-set.json` (otevřený P61 holdout 24 + P61 dev 12) přečetla astra jednou na větu přes `evals/play/p58b/compare.measure.ts` → `readings.astra.json`. Útrata 1,103 USD.

`diagnose.mjs` projde cestu čtení jako server: čtečka → klasifikátor → skladba → překlad rolí → publikace, a zapíše krok rozchodu do `diagnosis.json`. Rozhodnutí o řetězu čte `chain/read.ts` (jako `route.ts`), žánr sestavené jízdy (`assembled.drive` bez `spec.genre`) bere ze skladby.

**Rozpracováno (T1 nedokončen):** tabulka příčin po větách, test diagnózy a snímky `main` na zapečetěné sadě.

## Výchozí stav `main` na dev (T1, 27. 10., `495bbc77`)

`baseline-dev.json`, Claude ×1, listy desktop: rychlá hra 0,50 / 0,40, po čtení 0,50 / 0,40 (n = 11), hra ze čtení jen u řetězů s006 a s022 (0,425 / 0,40). s069 bez platné odpovědi soudce. Server zaplatil 12 čtení.

## Útrata čtení

| Krok | USD |
|---|---|
| T1 čtení pro diagnózu (36 vět, compare.measure) | 1,103 |
