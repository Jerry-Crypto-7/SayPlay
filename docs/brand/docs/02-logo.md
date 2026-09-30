# 02 · Logo

Files in `/logo`. The wordmark is **outlined paths** (Bricolage Grotesque 800, −0.04em tracking). Never retype it in a font.

| File | Use |
|---|---|
| `logo-lockup.svg` | Default. On cream, paper, sun, light imagery |
| `logo-lockup-on-dark.svg` | On ink `#1F1A17` or very dark game scenes |
| `logo-lockup-mono-ink.svg` | One-colour contexts, on tomato, embossing, print |
| `logo-lockup-mono-white.svg` | One-colour on dark photography/video |
| `mark*.svg` | Speech bubble + play. App icon, favicon, avatar, loading, watermark on share clips |
| `wordmark*.svg` | Only where the mark already appears nearby (e.g. app bar after splash) |

## Construction
The mark is a speech bubble (what you say) containing a play triangle (what you play). Tomato fill, 2.5 unit ink outline on a 34-unit grid, ink triangle.

## Clear space & minimum size
- Clear space ≥ **½ mark height** on all sides.
- Lockup min height **24px** (screen) / 10mm (print). Below that use the mark alone, min **16px**.
- In the app bar: lockup height **30px**.

## Do not
- Recolour the bubble (it is always tomato, or mono).
- Put the full-colour logo on tomato or busy photos (use mono).
- Add shadow, gradient, outline glow or rotation.
- Stretch, condense, rearrange mark and wordmark, or change the gap.
- Use the mark as a generic "play" button icon in the UI. Use `icons/play.svg` instead.
