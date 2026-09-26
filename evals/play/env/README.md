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

## Panorama za hrou a první snímek (T5, 26. 9. 2026)

`e2e/play-env.spec.ts`: arkáda, grid, timing, rhythm a duel mají `data-env` a
horní pás plátna (15 % výšky, HUD skrytý) není jedna plochá barva. Měří se
podíl nejčastější přesné barvy: s panoramatem **0,002–0,091**, s vrácenou
plochou oblohou (mutace) **0,953–1,000**, práh 0,5. Druhý test: požadavek na
`/env/*.webp` začne až po prvním WebGL draw callu (mutace „stahuj hned“ →
červené). První verze testu měřila rozptyl jasu a značku, kterou psala sama
Panorama – obě mutace jí prošly.

První snímek (`e2e/play-perf.spec.ts`, desktop, medián, RTX 3090, vždy jen
jeden server):

| hra | základ `8721395f` | po T5 | změna |
|---|---|---|---|
| runner | 522 ms (5 běhů) | 507 ms (5 běhů) | −3 % |
| grid-collect | 710 ms (7 běhů) | 684 ms (7 běhů) | −4 % |

Past, kterou měření chytilo: `GridScenery` se importuje staticky do stránky
gridu a statický import `Panorama.tsx` tam vtáhl `@react-three/fiber` do
úvodního balíku – grid kreslil první snímek za **929 ms (+31 %)**. Grid proto
načítá panorama přes `lazy()`, kontext `PlayEnv` bydlí zvlášť v `play-env.tsx`.
