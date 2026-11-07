# P75 – slepý soudce proti konceptu A

Skript `scripts/play/p75-judge.mjs`. Každý list: vlevo A, vpravo B – koncept A (`target/<věta>.png`, FLUX.2-klein přemalování snímku hry) a desktopový snímek hry se stejným výřezem; strana hry losovaná ze semínka, klíč jen v `judge.json`. Soudce Codex (`codex exec -i sheet.png` v prázdném dočasném adresáři), otázka:

> The attached image shows two pictures, A (left) and B (right), of a game scene for the sentence: "<věta>". Which one looks like a better finished game scene? Answer A, B or SAME. Reply only with the JSON the schema asks for: winner = "A", "B" or "SAME", reason = one or two sentences naming what decided it.

Věta projde, když hra vyhraje nebo soudce řekne SAME. **Brána T8: aspoň 4/12.**

| běh | hra | souzeno | semínko | hra ≥ SAME | volby soudce |
|---|---|---|---|---|---|
| main | `evals/play/p73/sceny/after` · 1play | 2026-11-07 14:10 | 7501 | **0/12** | A 6× · B 6× · SAME 0× |
| t5 | `evals/play/p75/t5` · 1play | 2026-11-07 16:19 | 7501 | **0/12** | A 6× · B 6× · SAME 0× |
| t6 | `evals/play/p75/after` · 1play | 2026-11-07 16:38 | 7501 | **0/12** | A 6× · B 6× · SAME 0× |

## main

| # | věta | hra na listu | výsledek | důvod soudce | list |
|---|---|---|---|---|---|
| s1 | Escape a volcano before the lava reaches you | A | koncept | B looks more polished, with cohesive lighting, detailed glowing lava, and a clear focal point framed by the canyon and volcano. A has overly dark terrain and flatter materials that make the scene feel less finished. | [list](judge/main/s1.jpg) |
| s2 | An underwater race between a turtle and a shark | A | koncept | B has more polished lighting, cohesive materials, and richer environmental detail, with a clearly recognizable turtle and shark. A looks rougher and features cars that distract from the intended race. | [list](judge/main/s2.jpg) |
| s3 | A cat delivering pizzas across rooftops while avoiding seagulls | A | koncept | B has polished lighting, cohesive stylized models, and a clear composition showing the cat carrying pizza while dodging seagulls. A looks less finished, with sparse scenery, muted lighting, and clipped elements at the edges. | [list](judge/main/s3.jpg) |
| s4 | Balance a tower of pancakes on a windy day | B | koncept | A has cohesive, polished lighting and materials, with a clear pancake tower and windblown leaves that match the prompt. B looks unfinished, with rough geometry and generic blocks instead of recognizable pancakes. | [list](judge/main/s4.jpg) |
| s5 | A knight jumps across floating islands to rescue a dragon egg | A | koncept | B has more cohesive lighting, polished materials, and a clearer composition that highlights the jumping knight and dragon egg. A looks more like a rough prototype, with cluttered scenery and less consistent visual detail. | [list](judge/main/s5.jpg) |
| s6 | A spaceship shoots asteroids in deep space | B | koncept | A looks more polished, with cohesive lighting, detailed asteroids, and a clear spaceship firing through deep space. B has flatter lighting and a sparse ground-based setting that fits the premise less well. | [list](judge/main/s6.jpg) |
| s7 | Play mini golf in a candy land | B | koncept | A has polished lighting, cohesive candy-themed obstacles, and a detailed mini-golf course. B looks sparse and unfinished, with flat scenery and a large demo overlay obscuring the scene. | [list](judge/main/s7.jpg) |
| s8 | Find the lost crown in an old castle | A | koncept | B has a cohesive castle setting, polished lighting, and a clearly visible crown. A looks unfinished, with blank panels, sparse scenery, and an intrusive demo overlay. | [list](judge/main/s8.jpg) |
| s9 | A bird flies through a stormy city | B | koncept | A has polished lighting, cohesive stylized buildings, and a clearly visible bird framed by dramatic storm clouds and lightning. B looks less finished, with sparse scenery and dense rain obscuring the scene. | [list](judge/main/s9.jpg) |
| s10 | A farmer catches falling apples in the orchard | B | koncept | A looks more polished, with cohesive rounded models, warm lighting, and a clear composition. B has game UI, but its harsh shadows, rough geometry, and crowded layout make it feel less finished. | [list](judge/main/s10.jpg) |
| s11 | A dog races a cat through a candy land | B | koncept | A looks more polished, with cohesive candy-land scenery, warm lighting, and a clearly modeled animal character. B has rougher geometry and vehicle opponents that fit the described scene less well. | [list](judge/main/s11.jpg) |
| s12 | A penguin slides down an icy mountain | A | koncept | B looks more finished thanks to cohesive stylized assets, polished lighting, and a clearly composed icy path. A has more gameplay UI, but its scattered props and inconsistent visual detail make it feel less refined. | [list](judge/main/s12.jpg) |

## t5

| # | věta | hra na listu | výsledek | důvod soudce | list |
|---|---|---|---|---|---|
| s1 | Escape a volcano before the lava reaches you | A | koncept | B has more polished lighting, clearer composition, and cohesive terrain and character design. A looks less finished because large dark shapes obscure the scene and the interface feels crowded. | [list](judge/t5/s1.jpg) |
| s2 | An underwater race between a turtle and a shark | A | koncept | B looks more polished, with cohesive materials, warm lighting, detailed characters, and a clearly visible shark opponent. A has game UI, but its flatter scenery and rougher character rendering feel less finished. | [list](judge/t5/s2.jpg) |
| s3 | A cat delivering pizzas across rooftops while avoiding seagulls | A | koncept | B has more polished lighting, cohesive materials, and a clear composition showing the cat carrying pizza while dodging seagulls. A feels unfinished, with a sparse rooftop, blurry scenery, and clipped interface elements. | [list](judge/t5/s3.jpg) |
| s4 | Balance a tower of pancakes on a windy day | B | koncept | A has cohesive stylized art, polished lighting, and a clear pancake tower with windblown leaves that communicates the premise. B looks unfinished, with rough geometry, sparse scenery, and a visible green guide overlapping the pancakes. | [list](judge/t5/s4.jpg) |
| s5 | A knight jumps across floating islands to rescue a dragon egg | A | koncept | B has more polished lighting, cohesive materials, and a clearer composition that highlights the jumping knight and dragon egg. A looks rougher, with crowded scenery and less refined geometry. | [list](judge/t5/s5.jpg) |
| s6 | A spaceship shoots asteroids in deep space | B | koncept | A looks more polished, with cohesive lighting, richer materials, and a clear spaceship firing among asteroids in space. B has flatter scenery and a cluttered interface, making it feel more like an unfinished prototype. | [list](judge/t5/s6.jpg) |
| s7 | Play mini golf in a candy land | B | koncept | A has polished lighting, cohesive candy-themed scenery, and a clearly composed mini-golf course. B looks rougher, with sparse scenery, a faceted ball, and a large overlay obscuring the scene. | [list](judge/t5/s7.jpg) |
| s8 | Find the lost crown in an old castle | A | koncept | B has a cohesive, polished castle setting with clear composition and a prominent crown. A looks unfinished, with excessive blur, sparse scenery, and a large completion overlay obscuring the scene. | [list](judge/t5/s8.jpg) |
| s9 | A bird flies through a stormy city | B | koncept | A has cohesive, polished lighting, detailed city buildings, and a clearly visible bird framed by dramatic storm clouds and lightning. B looks less finished, with sparse scenery, dark lighting, and dense rain obscuring the action. | [list](judge/t5/s9.jpg) |
| s10 | A farmer catches falling apples in the orchard | B | koncept | A looks more polished, with cohesive lighting, rounded models, detailed scenery, and a clear composition. B has game UI, but its harsh shadows, flat ground, and rougher models make it feel less finished. | [list](judge/t5/s10.jpg) |
| s11 | A dog races a cat through a candy land | B | koncept | A has more polished lighting, cohesive scenery, and clearer candy-land details, with lollipop decorations and striped barriers. B has gameplay UI, but its flatter rendering and rougher character models look less finished. | [list](judge/t5/s11.jpg) |
| s12 | A penguin slides down an icy mountain | A | koncept | B has more cohesive art direction, polished lighting, and a richly composed snowy environment. A looks more like a prototype, with sparse scenery and less consistent visual detail. | [list](judge/t5/s12.jpg) |

## t6

| # | věta | hra na listu | výsledek | důvod soudce | list |
|---|---|---|---|---|---|
| s1 | Escape a volcano before the lava reaches you | A | koncept | B has more polished lighting, cohesive stylized geometry, and a stronger composition centered on the volcano and glowing lava. A looks less finished because of its cluttered scenery and inconsistent asset quality. | [list](judge/t6/s1.jpg) |
| s2 | An underwater race between a turtle and a shark | A | koncept | B looks more polished, with cohesive materials, richer lighting, and more detailed turtle and shark models. Its scenery and track feel more deliberately composed, while A looks like an early gameplay prototype. | [list](judge/t6/s2.jpg) |
| s3 | A cat delivering pizzas across rooftops while avoiding seagulls | A | koncept | B has polished lighting, cohesive styling, and a clear rooftop composition featuring a cat carrying pizza while seagulls fly nearby. A feels unfinished, with a largely empty rooftop and distracting cropped elements. | [list](judge/t6/s3.jpg) |
| s4 | Balance a tower of pancakes on a windy day | B | koncept | A has cohesive styling, polished lighting, and a clear pancake tower with windblown leaves that communicate the premise. B looks unfinished, with disconnected props, overlapping pancakes, and a sparse environment. | [list](judge/t6/s4.jpg) |
| s5 | A knight jumps across floating islands to rescue a dragon egg | A | koncept | B has more polished lighting, cohesive materials, and a clearer composition showing the knight mid-jump toward the dragon egg. A feels less finished because of its cluttered scenery and uneven visual detail. | [list](judge/t6/s5.jpg) |
| s6 | A spaceship shoots asteroids in deep space | B | koncept | A has cohesive lighting, polished materials, and a clear spaceship firing among asteroids in deep space. B looks rougher and takes place on a planetary surface, with cluttered scenery and less refined presentation. | [list](judge/t6/s6.jpg) |
| s7 | Play mini golf in a candy land | B | koncept | A has polished lighting, cohesive candy-themed obstacles, and a clearly composed mini-golf course. B looks rougher, with sparse geometry and a large completion overlay obscuring the scene. | [list](judge/t6/s7.jpg) |
| s8 | Find the lost crown in an old castle | A | koncept | B has a polished, cohesive castle courtyard with clear lighting, detailed props, and an obvious crown objective. A is heavily blurred and obscured by a large completion overlay, making the scene feel less finished. | [list](judge/t6/s8.jpg) |
| s9 | A bird flies through a stormy city | B | koncept | A has polished lighting, cohesive stylized buildings, and a clearly visible bird framed by dramatic storm clouds and lightning. B looks less finished, with dim lighting, sparse scenery, and rain that obscures the action. | [list](judge/t6/s9.jpg) |
| s10 | A farmer catches falling apples in the orchard | B | koncept | A has more polished lighting, cohesive colors, and smoother models, making the orchard feel carefully finished. B has useful game UI, but its harsh shadows and rougher visuals make it look less refined. | [list](judge/t6/s10.jpg) |
| s11 | A dog races a cat through a candy land | B | koncept | A has more polished lighting, richer materials, and a clearer dog character, while the lollipops and striped barriers strongly establish candy land. B looks rougher and its environment reads more like an ordinary park. | [list](judge/t6/s11.jpg) |
| s12 | A penguin slides down an icy mountain | A | koncept | B looks more polished, with cohesive snowy scenery, warm lighting, and a clearly sculpted downhill track. A feels more like a prototype, with scattered props and a flatter, less cohesive environment. | [list](judge/t6/s12.jpg) |
