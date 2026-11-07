# P74 T6 – kontrola historie a tajemství před řezem (7. 11. 2026)

Jen čtení: v historii se nic nepřepisovalo a do repa se nic z nástrojů nezapsalo. Nálezy se tu necitují, jen soubor, commit a typ.

## `node scripts/blind-check.mjs` nad `rev-list --all`

Spuštěno ručně nad `04c78281`, 3208 revizí ve všech větvích.

| kontrola | výsledek |
|---|---|
| [1] identita commitů nenese autora | PASS |
| [2] lokální identita repa přebíjí globální | PASS |
| [3] obsah nezmiňuje organizátora ani skutečného autora | PASS |
| [4] `SECURITY-FINDINGS.md` nikdy nevstoupil do historie | PASS |
| [5] cíl pushe míří na anonymní účet | SKIP – pouští se jen z hooku pushe; při pushi `c3376fea` týž den PASS |
| [6] do historie nevstoupily přihlašovací údaje ani surové artefakty běhů | PASS |

## `gitleaks detect --log-opts=--all` (8.30.0, `--redact`)

Nad `04c78281`: 3050 commitů, 255,77 MB, **3 nálezy**, všechny pravidlo `generic-api-key`.

| soubor | řádek | commit | typ | v `HEAD` |
|---|---|---|---|---|
| `ops/env/tests/test_server.py` | 18 | `77c0a132` | testovací klíč, který si test sám vytvoří a předá aplikaci pod testem (`create_app(KEY, FakeGenerator…)`) | ano |
| `evals/worldstream/__tests__/measure-create.test.ts` | 678 | `c8a79b39` | falešný tvar klíče pro test detektoru tajemství (komentář v souboru: test nepotřebuje pravý tvar) | ne |
| `evals/worldstream/__tests__/measure-create.test.ts` | 917 | `f1c7e62e` | falešná adresa s klíčem na doméně `example` pro týž test | ne |

Inference: ani jeden nález není skutečný přihlašovací údaj, jsou to testovací fixtury. Ověřené je to jen z kódu kolem nich, hodnoty se nikde nezkoušely. Nové R z toho nevzniká.
