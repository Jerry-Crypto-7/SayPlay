# 10 · Icons

- 24×24 grid, **2.2px** stroke, round caps & joins, no fills (except dots in `dice`), `stroke="currentColor"`.
- Sizes: 24 default · 18 inside S buttons & chips · 26 inside 60px+ buttons · 20–22 in HUD.
- Colour follows text (ink). Exceptions: wand icon in the remix button is tomato; success check is grass; alert is alarm.
- Icon-only buttons always get `aria-label` ("Pause", "Restart", "Share", "Say it out loud").
- Never use emoji as icons, never mix in a third-party icon set. Need a new icon? Draw it on the same grid and add it to `/icons` and `sprite.svg`.

## Set (31)
mic · dice · play · plus · grid · user · restart · share · wand · pause · close · link · story · download · message · egg · clock · check · chevron-left · chevron-right · arrow-right · info · alert · sound-on · sound-off · trophy · settings · search · heart · flag · eye-off

## Usage
```html
<!-- inline sprite once per page -->
<svg class="sp-icon" aria-hidden="true"><use href="/icons/sprite.svg#sp-mic"/></svg>
```
