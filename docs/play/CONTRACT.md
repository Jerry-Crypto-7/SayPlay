# WORLDSTREAM PLAY – kontrakt vrstev (P23)

**Věta → krátká hratelná 3D hra → zahrát → změnit jednu věc → remix → sdílet.** Vrstva
`GameSpec` stojí **nad** `WorldDoc`; runtime (`src/sim`, `src/ir`, `src/verify`) se
tvarem nemění.

```
věta ─► Režisér ─► GameSpecV1 ─► Kompilátor ─► WorldstreamBlueprint ─► existující runtime
              (model)            (deterministický)   (world + geometry + objects)
                                        │
                                        └─► Verifikátor: keypointy + svědek + replay ─► QualityReport
GameVersion = hash(specHash, worldHash, seed, verze schématu/kompilátoru/runtimu, parentId)
```

## Kdo co vlastní

| Vrstva | Adresáře (výhradně) | Plán |
|---|---|---|
| Základ: schéma, registr, kontrakty, fixtury | `src/play/spec.ts`, `src/play/registry.ts`, `src/play/contracts.ts`, `src/play/__fixtures__/`, `src/play/__tests__/spec.test.ts` | hotovo 20. 9. 2026 – **nemění žádný z plánů**; potřebná změna se zapíše jako nález do `docs/play/CONTRACT-CHANGES.md` |
| Kompilátor + verifikátor | `src/play/compile/**`, `src/play/verify/**`, `evals/play/compiled/**` | P23-A |
| Režisér (model) + okamžitý návrh | `src/play/director/**`, `src/play/draft/**`, `evals/play/golden/**`, `evals/play/director*.measure.ts` | P23-B |
| Obálka PLAY, publikace, remix, sdílení | `src/app/play/**`, `src/app/api/play/**`, `src/components/play/**`, `src/play/version/**`, `src/play/remix/**`, `e2e/play-*.spec.ts`; jediná výjimka mimo ně: `'play'` přidané do `RateLimitedDoor` v `src/server/rate-limit.ts` | P23-C |
| Integrace, feed, regresní harness, brány | `src/play/index.ts`, `evals/play/regression/**`, `docs/play/GATES.md` | P23-D (po sloučení A+B+C) |

Pravidla, která drží paralelní běh bez konfliktů: **žádný plán nesahá do adresáře jiného
plánu**, nepřidává závislost do `package.json`, nemění `vitest.config.mts`, `playwright.config.ts`,
`src/app/page.tsx` ani `CLAUDE.md`. Dvojníka cizí vrstvy si každý plán píše u sebe v
`__fixtures__` z fixtur základu. Sdílený typ chybí → nález do `CONTRACT-CHANGES.md`, ne úprava
`contracts.ts`.

Balíček GPT (prompty režiséra/kritika/opravy, zlatý korpus, měď produktu, brány) leží v
`docs/play/pack/` – plány z něj čtou odtud, ne z dočasných adresářů.

## Rozhodnutí, která balíček GPT z 19. 9. neznal

1. **Ovládání je „klepni na cíl“** (`moveTo` / `pickup` / `use`, `src/game/flow.ts`), runtime je
   mřížkový bez fyziky. Proto `hazard_platforming` → `hazard_crossing` (pulzující nebezpečné zóny
   a kameny, žádný skok) a `combat_lite` = „přistup a použij“, žádný projektil. Mechaniky
   `projectile`, `moving_platform`, `jump` v registru nejsou a fail-closed je odmítá.
2. **Model píše jen GameSpec** (~1–2 kB). Dnešní kompilátor nechává model psát celý blueprint
   (164–188 s na svět, P21 T21); deterministický kompilátor z GameSpecu běží v milisekundách.
3. **Okamžitá hratelnost** vzniká deterministickým návrhem ze slov věty (`src/play/draft`),
   ne rychlejším modelem. Astra přes Codex CLI zůstává (rozhodnutí 18. 9.), placené API až na finále.
4. `chaser` se snižuje na pravidla `onSeen` + `inZone(player, Z) → moveTo(chaser, soket Z)` nad
   zónami mřížky – žádné nové primitivum tiku.
