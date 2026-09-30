# 08 · Game HUD

The HUD sits over a generated 3D world whose colours we do not control. Readability beats subtlety.

## Layout (portrait)
```
[ progress pill ]                 [ timer pill ] ( pause )
[ objective line — first 4s ]

            (middle third stays clear)

     world tags float above objects

            [ status pill ]
( restart )   [ Change one thing ]   ( share )
```
Landscape/desktop: same corners, bottom row centred with max width 520px.

## Pieces
| Element | Class | Spec |
|---|---|---|
| Progress | `.sp-hud-pill` | The actual objective objects as icons: collected = sun fill, remaining = dashed outline, then count `3/5` (Bricolage 800 18) |
| Timer | `.sp-hud-pill--sun` | `14.2s`, tabular figures, counts up (or down for survive games — then turns tomato under 5s) |
| Pause / restart / share | `.sp-hud-btn` | 50px circles (58–60 at bottom), sm shadow |
| Objective | `.sp-objective` | One line, ≤ 50 chars, fades out after 4s, reappears on pause |
| Remix | `.sp-btn--m.--secondary`, pill | "Change one thing", wand icon in tomato |
| World tag | `.sp-world-tag` | Screen-projected label above a 3D object. Tomato = threat ("Dog! Run!"), sun (`--goal`) = target ("Gate"). −4° tilt, max 3 at once, clamp 16px inside safe area, hide when object is off-screen and show an edge arrow instead |
| Status | `.sp-status` | Background generation state |

## Rules
- Surfaces are opaque paper/sun + ink border. **No glass, blur or transparency.**
- Minimum hit area 50px. Controls never overlap the middle third.
- Collecting an item: the matching egg icon pops (`sp-pop-in`, 420ms, pop easing) + short sound + light haptic.
- Getting caught: screen shake ≤ 6px for 200ms (off with reduced motion), tomato flash on the progress pill border.
- Pause overlay: scrim ink 45% + centred card (Resume primary, Restart, Change one thing, Quit). Game audio ducks.
- Keep HUD DOM separate from the canvas; do not render HUD text inside WebGL.

## Result screen
Top 30%: frozen game frame + celebration badge (sun circle, ink border, −6°, time + one word e.g. "Speedy!").
Sheet: `display-m` headline ("You did it!" / "So close."), one-line summary, 3 stats, primary **Dare a friend to beat it**, then M buttons **Play again · Remix it**, then link buttons **Copy link · Post to story · Save video**.
Lose state: headline "So close.", primary becomes **Try again**, Dare button moves to secondary.
