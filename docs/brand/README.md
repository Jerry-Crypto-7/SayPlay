# Sayplay — Brand & UI kit for developers (v1.0)

Everything needed to build Sayplay (mobile web/app + desktop): design tokens, fonts, logo, icons, a reference component stylesheet, game HUD rules and copy guidelines.

> Sayplay turns one sentence into a short playable 3D game. The UI is a toy box: cream paper, ink outlines, hard shadows, one tomato-red action per screen. Say it. Play it.

## Start here

1. Open **`Sayplay-Brand-UI-Guidelines-v1.0.pdf`** (or `guidelines.html` in a browser for live components) for a 15-page visual overview.
2. Read `docs/` for the rules and the reasoning. Each file is short.
3. Wire up the three CSS files, in this order:

```html
<link rel="preload" href="/fonts/BricolageGrotesque-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/Figtree-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="/tokens/tokens.css">
<link rel="stylesheet" href="/components/sayplay.css">
<body class="sp-root">…</body>
```

4. Using Tailwind? Add the preset instead of (or alongside) `tokens.css`:

```js
// tailwind.config.js
module.exports = { presets: [require('./tokens/tailwind.preset.js')], content: ['./src/**/*.{ts,tsx,html}'] };
```

5. In the 3D game (three.js etc.) import numeric colours from `tokens/tokens.ts` → `colorHex.tomato` (`0xFF5A36`).

## What's in the box

| Folder | Contents |
|---|---|
| `tokens/` | `tokens.json` (W3C DTCG — source of truth), `tokens.css` (CSS variables), `tokens.ts` (TypeScript + `colorHex` for engines), `tailwind.preset.js` |
| `fonts/` | Bricolage Grotesque + Figtree as variable `.woff2` and `.ttf`, `fonts.css`, OFL licences (free for commercial use, self-host them) |
| `logo/` | Lockup, mark and wordmark SVGs (text outlined) in colour, on-dark, mono ink, mono white + PNGs |
| `app-icon/` | iOS/Android/PWA/favicon sizes, adaptive icon layers, `favicon.svg`, `favicon.ico` |
| `icons/` | 31 UI icons (24px grid, 2.2 stroke, `currentColor`) + `sprite.svg` |
| `components/` | `sayplay.css` — reference implementation of every component (buttons, prompt, chips, idea cards, tab bar, sheet, toast, status, progress, HUD) |
| `reference-screens/` | Home, In-game, Win as static HTML + @2x PNG. Target look, not production code |
| `docs/` | The rules, one topic per file |
| `guidelines.html` / `.pdf` | Visual manual with live components |

## Docs index

1. [Brand foundations](docs/01-brand-foundations.md)
2. [Logo](docs/02-logo.md)
3. [Colour](docs/03-color.md)
4. [Typography](docs/04-typography.md)
5. [Layout, spacing & breakpoints](docs/05-layout.md)
6. [Shape, borders, shadows & tilt](docs/06-shape-depth.md)
7. [Components](docs/07-components.md)
8. [Game HUD](docs/08-game-hud.md)
9. [Motion](docs/09-motion.md)
10. [Icons](docs/10-icons.md)
11. [Voice & UI copy](docs/11-voice-copy.md)
12. [Accessibility](docs/12-accessibility.md)
13. [Assets, export & share cards](docs/13-assets.md)

## Non-negotiables (the short version)

- No purple or violet anywhere. Neutrals are warm: cream `#FFF3DF`, paper `#FFFFFF`, ink `#1F1A17`.
- Text on coloured fills is always **ink**. Never white text on tomato (3.1:1, fails).
- Every interactive surface: 2.5px ink border. Shadows are solid ink offsets, never blurred.
- Press = the element translates into its shadow and the shadow disappears.
- One tomato primary action per screen.
- Only idea cards, world tags and celebration badges may rotate.
- Use tokens, never raw hex, in product code. Change `tokens.json` → regenerate the rest.

## Versioning

Semantic versions. Token renames = major, new tokens = minor, value tweaks = patch. Keep a `CHANGELOG.md` in your repo when you change anything here.
