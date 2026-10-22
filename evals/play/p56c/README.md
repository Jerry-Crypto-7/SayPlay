# P56C – pět her z jedné věty (řetěz mikroher)

Plán `plans/P56C-pet-her-z-jedne-vety-2026-10-21.md` (necommitovaný). Větev `features/P56C-pet-her-z-jedne-vety-2026-10-21` z `origin/main` `ada7dd8b` posunutá na P55 `72665fdc`.

## Výchozí stav (T1)

`baseline.md`: čas do hratelné hry (`scripts/p32/shots.mjs`, `runs/baseline/result.json`) a cena kompilace a ověření návrhu z věty (`baseline.measure.ts` → `baseline-cost.json`).

## Sady (T2)

Obě napsal 21. 10. nezávislý subagent bez přístupu k repozitáři (kód, plány ani starší sady nečetl). Dostal jen popis čtyř rodin, tvar záznamu a pokyn psát jako porotce nebo hráč 13+ (vlastní slova, slang, bez jmen žánrů). Soubory zapsal sám a vrátil otisky a počty.

| Rodina | Co věta nese | dev | holdout |
|---|---|---|---|
| `multi_verb` | dvě a víc akcí s různým ovládáním | 12 | 12 |
| `single_verb` | jedno jasné sloveso s konkrétní hrou | 10 | 10 |
| `no_verb` | postava nebo nálada bez hratelné akce | 10 | 10 |
| `world_only` | jen místo nebo svět | 8 | 8 |

- **`dev.json`** – 40 vět, na kterých se ladí (T7, T8, T16). SHA-256 nad LF bajty `7f38c2c328619e1f0248f8b68aa07b77afc93daf80b00501ae7c000d7e370fcf` (jen pro informaci, dev se smí měnit).
- **`holdout.json`** – 40 vět, v relaci je nikdo nečetl. **SHA-256 nad LF bajty: `f8197a6cd96febc4edddaf88016495ad8de40e92a3522d3f8a03a9ebfc4b3b2e`**.
- `__tests__/sets.test.ts` hlídá otisk, počty rodin a nulový průnik (po `normalizeSentence`, na výstup jen id) s každým řetězcem v `p30/**/*.json`, `p54c/*.json`, `p55/*.json` a mezi dev a holdoutem.
- Holdout otevře jen `holdout.measure.ts` v T14, jednou: `openSealedOnce` (`seal.ts`, z P55) zapíše `holdout-opened.json` před prvním čtením a druhé otevření odmítne. Dokud ve stromu není rozhodnutí řetězu a slepý soudce, měření odmítne ještě před otevřením.
