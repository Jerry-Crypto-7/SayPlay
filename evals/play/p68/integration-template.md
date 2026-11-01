# P68 – předání hry k zapojení: `<id>` (kategorie `<kategorie>`)

Kategorie tento soubor vyplní ve svém řezu. P68-I hru zapne („zapoj X“) až ve chvíli, kdy je v `origin/main` značka
na konci souboru. Sdílené soubory (registry, klasifikátor, prompty, `disclosure.json`) mění jen P68-I – co v nich hra
potřebuje, patří do sekce „Požadované změny sdíleného kontraktu“.

## Popis pro režiséra a čtečku

Jedna až dvě věty vlastními slovy: co hráč pořád dělá, jak vyhraje, jak prohraje. Bez názvů cizích her.

## Věty pro klasifikátor

Anglické věty, které mají skončit v této hře (smí se převzít z `evals/play/p68/dev.json`), a věty, které v ní skončit
NESMÍ (podobná slova, jiná hra).

## Narážky

Slova pro `cues` modulu `src/play/genre/<id>.ts` a proč žádné z nich neukradne větu staré hře.

## Assety

| Soubor | Licence | Zdroj | Poznámka |
|---|---|---|---|

## Požadované změny sdíleného kontraktu

Co P68-I musí změnit mimo soubory hry (nový pohled nad `P68_VIEWS`, jemnější krok osy, nový počet…), s důvodem a
testem. Prázdné = nic.

## Fixture spec

Cesta k ručnímu specu, který hru hraje bez zapojení (např. `e2e/fixtures/p68-<id>-spec.json`).

<!-- Značku níže přidat až když je hra hotová (herní aserce z `assertions.json` zelené, e2e `play-<id>` bez `skip`). -->
<!-- p68-ready: <id> -->
