# P45H – scenérie podle prostředí

Plán: P45H (interní). Větev převzala fast-forwardem lokální `features/P45G-modely-prostredi-2026-10-11` (`50796f7d`) – slučuje se **po P45G**, ten po P45F.

## Co plán řeší

- **Problém (P45G T4):** věta, která jmenuje jen prostředí („ice fishing on a frozen lake“), nové rekvizity P45G nenačte. Scenérii vybírá pevná tabulka 17 sad v `src/play/arcade/look/index.ts` (`KEYWORDS` → `LOOKS` → `SCENERY_MODELS`), takže 74 nových modelů uvidí hráč jen ve větě, která je jmenuje.
- **Řešení:** tabulka prostředí → rekvizity (`src/play/arcade/look/setting-kits.json`), postavená skriptem z mapy `evals/play/p45g/kit-nouns.json` a katalogu, jen z povýšených modelů. Scéna podle ní rozmístí rekvizity kitu místo části rekvizit sady – počet objektů ve scéně se nezvětší.
- **Cíl:** věta, která jmenuje jen prostředí z kitu, ukáže ve scéně aspoň 2 jeho rekvizity; replay hash a stávající sady beze změny.
- **Mimo:** generování modelů (souběžný P45I), placená API, zapečetěné sady, režisér a jeho prompt.

## Na čem stojí

- `evals/play/p45g/kit-nouns.json` – 159 jmen, u každé rekvizity prostředí, ke kterým patří.
- `src/assets/catalog.json` – které z nich prošly soudem a jsou povýšené (74 nových modelů P45G).
- Determinismus podle `CLAUDE.md`: výběr a rozmístění jen přes `pure-rand` stream scenérie, nic z toho nesmí do hashovaného stavu.
