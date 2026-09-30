# 07 · Components

Reference implementation: `components/sayplay.css`. Live examples: `guidelines.html` pages 10–13. Port class-for-class into your framework; keep names so design and code talk the same language.

## Button `.sp-btn`
| Variant | Class | Fill | Text |
|---|---|---|---|
| Primary | `.sp-btn--primary` | tomato | ink |
| Secondary | `.sp-btn--secondary` | paper | ink |
| Sun | `.sp-btn--sun` | sun | ink |
| Link | `.sp-btn--link` | none, underlined | ink |

| Size | Class | Height | Radius | Shadow | Font |
|---|---|---|---|---|---|
| L | default | 62 | lg | md | Bricolage 22/800 |
| M | `.sp-btn--m` | 52 | md | sm | Figtree 16/800 |
| S | `.sp-btn--s` | 44 | pill | none | Figtree 14/700 |
| Icon | `.sp-btn--icon` (+`--l`) | 52 / 62 | pill | sm | icon 24 / 26 |

States: `:hover` (desktop: shadow +1 step), `:active`/`.is-pressed` (sink), `:focus-visible` (ink ring + sun halo), `:disabled` (cream-deep fill, ink-faint text & border, no shadow), `.is-loading` (label hidden, spinner, not clickable). `.sp-btn--block` = full width.
Rules: exactly **one** primary per screen. Icon buttons always have `aria-label`. Labels are verbs.

## Prompt `.sp-prompt`
The speech-bubble input — the heart of the product.
Parts: `__label` (visible, `label` style), `__field` (textarea, 19px/600, auto-grow 76–160px), `__actions` (Surprise me S button · counter · mic icon button in sun), `__count` (`0/140`).
States: focus-within lifts to `shadow-lg` with −2px translate; `.is-error` switches border to alarm and shows `.sp-field-error` below (icon + fix-it text). Limit **140 characters**; counter turns alarm at 130+.
Mic: while recording the mic button fills tomato and shows a live level ring; tap again to stop.

## Chip `.sp-chip`
44px, pill, 2px border, cream fill. Selected `.is-selected`: ink fill, cream text. Used for genre, remix suggestions. Single row, horizontal scroll on mobile, no wrapping beyond 2 rows.

## Idea card `.sp-idea`
Colour modifiers `--mint | --sun | --sky | --gum` in that order; tilt alternates `.sp-tilt-l/-r`. Tapping fills the prompt (does not start generation immediately) and scrolls the prompt into view. 2 columns mobile, 3 tablet, 4 desktop. Copy ≤ 45 characters.

## Card & stat
`.sp-card` generic paper container (lg radius, no shadow unless interactive). `.sp-stat` for result numbers: value (Bricolage 24) + label (caption, ink-soft). Stats come in rows of 3.

## Avatar `.sp-avatar`
44px circle, 2.5 border, sun fill with initials (Figtree 800 14) when no photo.

## App bar `.sp-appbar`
62px, logo lockup 30px high left, avatar right. No title text on the home screen.

## Tab bar `.sp-tabbar`
Floating, 66px, 12px from sides, xl radius, paper. 4 items max: **Make · Play · My games · Me**. Active item = ink pill with icon + label side by side; inactive = icon over 11px label. Hidden during gameplay. On desktop becomes the left rail.

## Bottom sheet `.sp-sheet` + `.sp-scrim`
Cream, 3px ink top border, 2xl top radius, handle. Scrim ink at 45%. Opens with `sheet-in` (240ms). Swipe down or Esc to close. Used for **Change one thing**, share options, settings.

## Status pill `.sp-status`
Ink pill, cream text, pulsing sun dot. For background system states (quick version loading, saving, uploading clip). **Replaces every blocking "AI is busy" dialog.** Never covers HUD controls.

## Toast `.sp-toast` / `--error`
Paper, 2.5 border, sm shadow, bottom-centre above tab bar, 3s (errors stay until dismissed or fixed). One at a time.

## Generation progress `.sp-steps`
4 steps, in this order and wording: **Reading your idea → Building the world → Setting the rules → Painting it in.** Done = mint check, current = sun pulsing, upcoming = dashed. Show the user's sentence above in `display-m`. If the full model is busy, skip to a playable quick version and show `.sp-status` in game.

## Screens map (MVP)
Home (prompt + ideas) → Building (steps) → Play (HUD) → Result (win/lose) → Change one thing (sheet) → Share (sheet: Dare a friend link, Post to story, Save video, Copy link) → My games (grid of cards) → Me (profile, settings).
