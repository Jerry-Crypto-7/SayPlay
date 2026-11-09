# P77 T1 – výchozí stav a diagnostika bez HUD

Skript `scripts/play/p77-diag.mjs` nad `evals/play/p75/judge.json` (soudce `scripts/play/p75-judge.mjs`, koncept A proti desktopovému snímku ve 3. s). Snímky: s HUD `evals/play/p77/base/` (`p73d-shots.mjs` nad `origin/main` a741b5b4), bez HUD `evals/play/p77/base-nohud/` (`p77-shots.mjs --no-hud`: všechno DOM nad plátnem skryté jen pro fotku, déšť zůstává).

## Skóre

| běh | hra ≥ SAME | souzeno |
|---|---|---|
| p77-base | **0/12** | 2026-11-08 07:54 |
| p77-base-nohud | **0/12** | 2026-11-08 07:58 |

**Závěr (inference):** bez HUD je výsledek stejný (0/12), takže rozdíl proti konceptu nedělá rozhraní – soudce bez HUD jmenuje pořád totéž: „polished / cohesive materials“ a světlo. Pořadí oprav z plánu platí: jednotnost kusů a barev (T2), světlo a stíny (T3), pak zem a kompozice (T4). Témata počítá regex nad slovy důvodu a „polished/cohesive“ je skoro v každém, proto jsou počty u prvních témat stejné – rozhoduje pořadí napříč větami níž, ne jednotlivé číslo.

## Proč koncept vyhrává – tři nejčastější témata na větu

Ze všech běhů v `judge.json` (main, t5, t6, t8, p77-base, p77-base-nohud), jen důvody, kde vyhrál koncept. Témata podle slov důvodu (`THEMES` ve skriptu); v závorce kolikrát.

| # | věta | s HUD | bez HUD | 1. | 2. | 3. | důvod bez HUD |
|---|---|---|---|---|---|---|---|
| s1 | Escape a volcano before the lava reaches you | koncept | koncept | jednotný styl a dotažení kusů (6) | světlo a stíny (6) | kompozice a hloubka (6) | B looks more polished, with cohesive geometry, strong lighting, and a clear focal point. The glowing lava and erupting volcano also communicate the danger more immediately. |
| s2 | An underwater race between a turtle and a shark | koncept | koncept | jednotný styl a dotažení kusů (6) | detail a materiály (6) | světlo a stíny (6) | B looks more finished thanks to polished models, cohesive materials, warm lighting, and richer environmental detail. A has flatter lighting and simpler, less refined geometry. |
| s3 | A cat delivering pizzas across rooftops while avoiding seagulls | koncept | koncept | jednotný styl a dotažení kusů (6) | světlo a stíny (6) | prázdná nebo plochá scéna (6) | B looks more polished, with cohesive lighting, detailed rooftop scenery, and a clearly readable pizza-carrying cat surrounded by seagulls. A feels unfinished, with sparse scenery and clipped interface elements. |
| s4 | Balance a tower of pancakes on a windy day | koncept | koncept | jednotný styl a dotažení kusů (6) | světlo a stíny (6) | čitelnost hrdiny a děje (6) | A has polished lighting, cohesive materials, and a clear pancake tower with windblown leaves that convey the premise. B looks unfinished, with scattered props, blank panels, and less cohesive composition. |
| s5 | A knight jumps across floating islands to rescue a dragon egg | koncept | koncept | jednotný styl a dotažení kusů (6) | detail a materiály (6) | světlo a stíny (6) | B has more polished lighting, cohesive materials, and a clearer composition. The airborne knight and prominently displayed egg also communicate the objective more effectively. |
| s6 | A spaceship shoots asteroids in deep space | koncept | koncept | jednotný styl a dotažení kusů (6) | detail a materiály (6) | světlo a stíny (6) | A has more polished lighting, cohesive materials, and stronger composition, with a clearly visible spaceship shooting among asteroids. B looks more like an unfinished ground-based prototype and conveys deep space less effectively. |
| s7 | Play mini golf in a candy land | koncept | koncept | jednotný styl a dotažení kusů (6) | světlo a stíny (6) | věrnost větě (prostředí) (6) | A has polished lighting, richer candy decorations, and a cohesive mini-golf course with rounded, finished geometry. B looks more sparse and rough, with angular objects and flatter materials. |
| s8 | Find the lost crown in an old castle | koncept | koncept | jednotný styl a dotažení kusů (6) | čitelnost hrdiny a děje (6) | věrnost větě (prostředí) (6) | B has a cohesive castle setting, polished lighting, and detailed props, with the crown clearly integrated as the objective. A looks unfinished, with blank panels, scattered blocks, and awkwardly cropped foreground elements. |
| s9 | A bird flies through a stormy city | koncept | koncept | jednotný styl a dotažení kusů (6) | světlo a stíny (6) | čitelnost hrdiny a děje (6) | A has polished lighting, cohesive stylized buildings, and a clearly visible bird amid dramatic storm effects. B looks less finished, with sparse geometry and heavy rain obscuring the scene. |
| s10 | A farmer catches falling apples in the orchard | koncept | koncept | jednotný styl a dotažení kusů (6) | detail a materiály (6) | světlo a stíny (6) | A has polished lighting, cohesive materials, and a balanced composition that feels like a finished game scene. B has harsher shadows, flatter surfaces, and a less integrated background. |
| s11 | A dog races a cat through a candy land | koncept | koncept | jednotný styl a dotažení kusů (6) | detail a materiály (6) | světlo a stíny (6) | A looks more finished thanks to polished lighting, richer materials, and cohesive candy-land scenery. B has simpler geometry and flatter shading, making it feel more like a prototype. |
| s12 | A penguin slides down an icy mountain | koncept | koncept | jednotný styl a dotažení kusů (6) | světlo a stíny (6) | prázdná nebo plochá scéna (5) | B looks more finished thanks to cohesive stylized trees, polished snow geometry, and warm lighting with convincing shadows. A feels sparser and less consistent, with scattered props and a flatter icy track. |

## Témata napříč větami

| téma | kolikrát |
|---|---|
| jednotný styl a dotažení kusů | 72 |
| světlo a stíny | 71 |
| čitelnost hrdiny a děje | 59 |
| detail a materiály | 51 |
| věrnost větě (prostředí) | 42 |
| prázdná nebo plochá scéna | 39 |
| kompozice a hloubka | 36 |
| rozhraní (HUD) | 29 |
| barvy | 15 |

