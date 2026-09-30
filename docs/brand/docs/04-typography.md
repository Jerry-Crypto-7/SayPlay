# 04 · Typography

Two families, both variable, both SIL OFL (free, self-host from `/fonts`).

| Family | Role | Weights used |
|---|---|---|
| **Bricolage Grotesque** | Display: headlines, large buttons, HUD numbers, stats | 800 only |
| **Figtree** | Body & UI: paragraphs, inputs, labels, small buttons, tabs | 500, 600, 700, 800 |

Fallback stacks are in `tokens.css` (`--sp-font-display`, `--sp-font-body`). `font-display: swap`. Preload both woff2 files.

## Scale (mobile → desktop ≥1024px)
| Token | Family | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|---|
| `display-xl` | Bricolage | 48 → 72 | 800 | 1.0 | −0.04em | Splash, desktop hero |
| `display-l` | Bricolage | 40 → 56 | 800 | 1.0 | −0.035em | Screen headline ("What do you want to play?") |
| `display-m` | Bricolage | 32 → 40 | 800 | 1.05 | −0.03em | Result headline ("You did it!") |
| `title-l` | Bricolage | 24 → 28 | 800 | 1.15 | −0.02em | Sheet titles |
| `title-m` | Bricolage | 19 → 20 | 800 | 1.2 | −0.01em | Section titles |
| `button-l` | Bricolage | 22 | 800 | 1.0 | −0.02em | L buttons |
| `button-m` | Figtree | 16 | 800 | 1.0 | 0 | M buttons |
| `body-l` | Figtree | 18 → 19 | 600 | 1.35 | 0 | Prompt input text, lead |
| `body` | Figtree | 16 | 500 | 1.45 | 0 | Paragraphs |
| `body-s` | Figtree | 14 | 600 | 1.4 | 0 | Chips, idea cards, toasts |
| `label` | Figtree | 13 | 700 | 1.25 | 0 | Field labels, status pill |
| `caption` | Figtree | 12 | 700 | 1.3 | 0.01em | Stat labels. **Minimum size in the product** |
| `hud-num` | Bricolage | 18 → 20 | 800 | 1.0 | −0.01em | Timer, counters |

Utility classes: `.sp-display-l`, `.sp-title-m`, `.sp-body`, `.sp-caption`…

## Rules
- Sentence case everywhere. No ALL-CAPS labels (exception: none).
- Numbers that change (timer, score, counters) use `font-variant-numeric: tabular-nums` (set globally on `.sp-root`).
- Headline highlight (`.sp-highlight`): max **one word per screen**, only in a `display-*` headline, tomato fill, −2° tilt.
- Line length ≤ 60 characters for body copy.
- Never use Bricolage below 16px or for paragraphs.
