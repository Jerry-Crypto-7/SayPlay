# Judge gauntlet – korpus porotcovských vět s orákuly

**Není zmrazený.** Věty i orákula se smí dopisovat a opravovat; každou změnu
hlídá `__tests__/corpus.test.ts`, ne hash. Zmrazení tady nic nevynucuje a nikde
se to nemá tvrdit (viz `CLAUDE.md` → Nedořešené rozpory).

**Orákula psal člověk – tahle session, 19. 9. 2026 – ne plánovač.** Každé
`required.quote` je doslovný podřetězec své věty, takže se dá srovnat
s `provenance.quote` v emisi plánovače, aniž by se hádalo, co model „myslel".
Počty jsou to, co věta říká, nebo nejmenší rozumné množství, kde věta mluví
v množném čísle bez čísla (`palm trees` → 2, `mushrooms` → 3).

## Soubory

| Soubor | Co v něm je |
|---|---|
| `prompts.json` | 120 vět, 20 kategorií po šesti; `packCategory` říká, pod jakým jménem stála věta ve strategickém balíčku (`plans/P22/strategy-pack/07_JUDGE_GAUNTLET.csv`, všech 14 doslovně) |
| `oracles.json` | jedno orákulum na větu: `required[{quote,count}]`, volitelně `forbidden[]` a `relations[{subject,relation,object}]`; kategorie `contradictory`, `unsupported`, `safety` nesou místo toho `expectedRefusalOrDegrade: true` |
| `__tests__/corpus.test.ts` | pin: doslovnost citátů, vztahy jen mezi citáty téhož orákula, ≥ 5 vět na kategorii, 14 vět balíčku |
| `gauntlet.json`, `gauntlet-answers/` | živý běh T17: 16 vět (jedna na kategorii mimo `contradictory`, `unsupported`, `safety`, `abstract`, semínko 4021) jednou skrz plánovač; odpovědi se **commitují**; skóre `null`, ne 0, když odpověď nepřišla (`gauntlet-score.ts`, pin `__tests__/gauntlet-report.test.ts`) |

Vztahy: `on | under | inside | behind | over | beside`; `subject` a `object`
jsou vždy citáty z `required` téhož orákula, aby je sémantické skóre (T2) našlo
v `spec.relations` přes provenance instancí.

## Volné konce, které se vědomě přijaly

- **Kategorie `ambiguous`** má orákula záměrně volná (`cozy`, `home`, `place`):
  věta neříká žádný objekt, takže se měří jen to, jestli plánovač něco ukotvil
  k jejímu jedinému nosnému slovu.
- **Kategorie `adversarial`** není odmítací: očekává se svět z té části věty,
  která svět popisuje, a `forbidden` hlídá, že do něj neprosákl zbytek.
- Kategorie balíčku, které v uzavřeném seznamu nejsou (`spatial`, `relation`,
  `count` → `count-relation`; `puzzle`, `counterfactual` → `narrative`;
  `weather` → `nature`; `failure` → `unsupported`), jsou přemapované a původní
  jméno zůstává v `packCategory`.

## Kdo korpus čte

- `semantic-archive.measure.ts` (T2) – archivní emise plánovače, orákula `p20-*`.
- `asset-demand.measure.ts` (T3) – poptávka po druzích objektů z citátů.
- `word-massing.measure.ts` (T4) – kolik vět dá bloky bez modelu.
- `gauntlet.measure.ts` (T17) – jeden živý běh plánovače nad vzorkem 16 vět.
