# Prostředí z věty – pokrytí korpusu (P29C T4)

`envFor(theme, seed)` (`src/play/arcade/look/env.ts`) vybírá panorama z katalogu
`src/play/arcade/look/env-catalog.json` podle slov `theme.setting`; když žádný
štítek nesedí, vezme variantu podle `lookOf(theme)` a seedu.

```
npx vitest run --config vitest.measure.mts evals/play/env/coverage.measure.ts
```

Píše `coverage.json`: pro 30 vět `fidelity/corpus.json` a 10 vět
`fidelity/judge-10.json` theme z návrhu ze slov (`draftGameSpec`, cesta bez
modelu), vybrané panorama a jeho štítky. Shoda = některý štítek je slovem
prostředí z checklistu věty. Věty, jejichž checklist prostředí nejmenuje, se do
podílu nepočítají.

## Naměřeno 26. 9. 2026

**27 z 33 = 0,818.** `src/play/arcade/look/__tests__/env-for.test.ts` hlídá, že
podíl neklesne pod 0,818.

Všech šest minutí vzniká **před** výběrem panoramatu: návrh ze slov napíše
prostředí, ve kterém slovo z věty už není (`sunny arcade track` pro větu o pláži
nebo o sněhu, `floating stone platforms` pro věž). Výběr nad tím nemá co trefit.
Opravit je patří čtení věty (P29B), ne katalogu.

| věta | prostředí z návrhu | panorama | slovo z checklistu |
|---|---|---|---|
| s022 | floating stone platforms | set-dungeon | tower |
| h03 | sunny park lawn | meadow-2 | castle, fortress, wall |
| j04 | sunny arcade track | set-race-track | beach, sea, shore |
| j07 | sunny arcade track | set-race-track | winter, snow |
| j08 | dusty shooting range at sunset | set-sunset | tower, crystal |
| j09 | dusty shooting range at sunset | set-sunset | village, town |
