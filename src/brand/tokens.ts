/* Sayplay design tokens v1.0, generated from docs/brand/tokens/tokens.json by scripts/brand/tokens.mjs. Do not edit by hand. */

export const color = {
  "ink": "#1F1A17",
  "ink-soft": "#5A524B",
  "ink-faint": "#6E655D",
  "cream": "#FFF3DF",
  "cream-deep": "#FFE7C2",
  "paper": "#FFFFFF",
  "tomato": "#FF5A36",
  "tomato-deep": "#E8421F",
  "sun": "#FFC530",
  "sun-deep": "#E9A800",
  "sun-soft": "#FFD66B",
  "mint": "#9BE3B0",
  "mint-deep": "#5CC486",
  "sky": "#8FD3FF",
  "sky-deep": "#4FB3F0",
  "bubblegum": "#FFB8C8",
  "alarm": "#C8231B",
  "grass": "#1E7A43"
} as const;

export const space = {
  "0": 0,
  "1": 4,
  "2": 8,
  "3": 12,
  "4": 16,
  "5": 20,
  "6": 24,
  "8": 32,
  "10": 40,
  "12": 48,
  "16": 64,
  "20": 80,
  "0.5": 2
} as const;

export const radius = {
  "xs": 8,
  "sm": 12,
  "md": 16,
  "lg": 20,
  "xl": 24,
  "2xl": 32,
  "pill": 999
} as const;

export const borderWidth = {
  "thin": 2,
  "base": 2.5,
  "thick": 3
} as const;

export const shadow = {
  "none": "none",
  "sm": "3px 3px 0 0 #1F1A17",
  "md": "5px 5px 0 0 #1F1A17",
  "lg": "7px 7px 0 0 #1F1A17"
} as const;

export const fontFamily = {
  "display": "'Roboto', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  "body": "'Roboto', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
} as const;

export const typography = {
  "display-xl": {
    "family": "display",
    "size": 48,
    "sizeDesktop": 72,
    "weight": 900,
    "lineHeight": 1,
    "letterSpacingEm": -0.04
  },
  "display-l": {
    "family": "display",
    "size": 40,
    "sizeDesktop": 56,
    "weight": 900,
    "lineHeight": 1,
    "letterSpacingEm": -0.035
  },
  "display-m": {
    "family": "display",
    "size": 32,
    "sizeDesktop": 40,
    "weight": 900,
    "lineHeight": 1.05,
    "letterSpacingEm": -0.03
  },
  "title-l": {
    "family": "display",
    "size": 24,
    "sizeDesktop": 28,
    "weight": 900,
    "lineHeight": 1.15,
    "letterSpacingEm": -0.02
  },
  "title-m": {
    "family": "display",
    "size": 19,
    "sizeDesktop": 20,
    "weight": 900,
    "lineHeight": 1.2,
    "letterSpacingEm": -0.01
  },
  "button-l": {
    "family": "display",
    "size": 22,
    "sizeDesktop": 22,
    "weight": 900,
    "lineHeight": 1,
    "letterSpacingEm": -0.02
  },
  "button-m": {
    "family": "body",
    "size": 16,
    "sizeDesktop": 16,
    "weight": 700,
    "lineHeight": 1,
    "letterSpacingEm": 0
  },
  "body-l": {
    "family": "body",
    "size": 18,
    "sizeDesktop": 19,
    "weight": 500,
    "lineHeight": 1.35,
    "letterSpacingEm": 0
  },
  "body": {
    "family": "body",
    "size": 16,
    "sizeDesktop": 16,
    "weight": 500,
    "lineHeight": 1.45,
    "letterSpacingEm": 0
  },
  "body-s": {
    "family": "body",
    "size": 14,
    "sizeDesktop": 14,
    "weight": 500,
    "lineHeight": 1.4,
    "letterSpacingEm": 0
  },
  "label": {
    "family": "body",
    "size": 13,
    "sizeDesktop": 13,
    "weight": 700,
    "lineHeight": 1.25,
    "letterSpacingEm": 0
  },
  "caption": {
    "family": "body",
    "size": 12,
    "sizeDesktop": 12,
    "weight": 700,
    "lineHeight": 1.3,
    "letterSpacingEm": 0.01
  },
  "hud-num": {
    "family": "display",
    "size": 18,
    "sizeDesktop": 20,
    "weight": 900,
    "lineHeight": 1,
    "letterSpacingEm": -0.01
  }
} as const;

export const motion = {
  "duration": {
    "press": null,
    "quick": null,
    "base": null,
    "celebrate": null
  },
  "easing": {
    "standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
    "pop": "cubic-bezier(0.34, 1.56, 0.64, 1)",
    "exit": "cubic-bezier(0.4, 0, 1, 1)"
  }
} as const;

export const breakpoint = {
  "sm": 0,
  "md": 600,
  "lg": 1024,
  "xl": 1440
} as const;

export const zIndex = {
  "base": 0,
  "hud": 10,
  "sticky": 20,
  "nav": 30,
  "sheet": 40,
  "toast": 50,
  "modal": 60
} as const;

export const size = {
  "touch-min": 44,
  "control-s": 44,
  "control-m": 52,
  "control-l": 62,
  "tabbar": 66,
  "hud-pill": 50,
  "icon": 24,
  "icon-s": 18
} as const;

/** Numeric hex (0xRRGGBB) for three.js and other engines. */
export const colorHex = {
  "ink": 0x1F1A17,
  "ink-soft": 0x5A524B,
  "ink-faint": 0x6E655D,
  "cream": 0xFFF3DF,
  "cream-deep": 0xFFE7C2,
  "paper": 0xFFFFFF,
  "tomato": 0xFF5A36,
  "tomato-deep": 0xE8421F,
  "sun": 0xFFC530,
  "sun-deep": 0xE9A800,
  "sun-soft": 0xFFD66B,
  "mint": 0x9BE3B0,
  "mint-deep": 0x5CC486,
  "sky": 0x8FD3FF,
  "sky-deep": 0x4FB3F0,
  "bubblegum": 0xFFB8C8,
  "alarm": 0xC8231B,
  "grass": 0x1E7A43,
} as const;
