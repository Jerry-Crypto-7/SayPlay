# P55 – žánr z věty a dění v pruzích

Plán `plans/P55-zanr-a-pruhy-2026-10-21.md` (necommitovaný). Větev `features/P55-zanr-a-pruhy-2026-10-21` z `origin/main` `ada7dd8b`.

## Výchozí stav (T1)

`baseline.md` a `baseline.json` (`P55_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p55/baseline.measure.ts`): žánr na p54c dev, p54c holdout-opened a p30 dev, dění ve čtyřech pruhových žánrech na semínku 1.

## Sady (T2)

- **Ladí se na existujících větách:** p54c `dev.json` (80) a p54c `holdout.json` (otevřený v P54C T16, od té doby vývojová data – 60 cílů nezávislého autora s opisy, na kterých P54C padla). Nová vývojová sada se nepíše.
- **`holdout.json`** – 80 vět, které 21. 10. napsal nezávislý subagent bez přístupu k repozitáři (kód, plány ani sady nečetl). Dostal jen osm jednovětých popisů žánrů, tvar záznamu a pokyn psát jako hráči 13+ (opisy, slang, bez jmen žánrů): 60 cílových (8 na catch, whack, defense, slice, 7 na hop, crowd, merge, push) a 20 rušivých (`genre: null`, jiná hra s lákavým slovem). Soubor zapsal sám a vrátil jen otisk a počty; v relaci ho nikdo nečetl. **SHA-256 nad LF bajty: `7ee816ac289a957e17fb706956aa98c4ab6ce404b3c282cd296fca6c1bfe0537`**.
- `__tests__/sets.test.ts` hlídá otisk, počty a nulový průnik s p54c dev, p54c holdoutem a p30 dev (po `normalizeSentence`, na výstup jen id). Otevře ji jen `holdout.measure.ts` v T9, jednou: `openSealedOnce` (`seal.ts`) zapíše `holdout-opened.json` před prvním čtením a druhé otevření odmítne.
