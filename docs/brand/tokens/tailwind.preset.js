/* Sayplay Tailwind preset v1.0 — generated from tokens.json
 * Usage: // tailwind.config.js
 *   module.exports = { presets: [require('./tokens/tailwind.preset.js')], content: [...] }
 * Desktop type sizes: use lg: variants, e.g. text-display-l lg:text-[56px] — see docs/04-typography.md
 */
module.exports = {
  "theme": {
    "colors": {
      "transparent": "transparent",
      "current": "currentColor",
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
    },
    "spacing": {
      "0": "0px",
      "0.5": "2px",
      "1": "4px",
      "2": "8px",
      "3": "12px",
      "4": "16px",
      "5": "20px",
      "6": "24px",
      "8": "32px",
      "10": "40px",
      "12": "48px",
      "16": "64px",
      "20": "80px"
    },
    "borderRadius": {
      "xs": "8px",
      "sm": "12px",
      "DEFAULT": "16px",
      "lg": "20px",
      "xl": "24px",
      "2xl": "32px",
      "pill": "999px",
      "md": "16px",
      "none": "0"
    },
    "borderWidth": {
      "0": "0",
      "DEFAULT": "2.5px",
      "thin": "2px",
      "base": "2.5px",
      "thick": "3px"
    },
    "boxShadow": {
      "none": "none",
      "sm": "3px 3px 0 0 #1F1A17",
      "md": "5px 5px 0 0 #1F1A17",
      "lg": "7px 7px 0 0 #1F1A17"
    },
    "fontFamily": {
      "display": [
        "Bricolage Grotesque",
        "Arial Rounded MT Bold",
        "Helvetica Neue",
        "Arial",
        "sans-serif"
      ],
      "body": [
        "Figtree",
        "Helvetica Neue",
        "Arial",
        "sans-serif"
      ]
    },
    "fontSize": {
      "display-xl": [
        "48px",
        {
          "lineHeight": "1.0",
          "letterSpacing": "-0.04em",
          "fontWeight": "800"
        }
      ],
      "display-l": [
        "40px",
        {
          "lineHeight": "1.0",
          "letterSpacing": "-0.035em",
          "fontWeight": "800"
        }
      ],
      "display-m": [
        "32px",
        {
          "lineHeight": "1.05",
          "letterSpacing": "-0.03em",
          "fontWeight": "800"
        }
      ],
      "title-l": [
        "24px",
        {
          "lineHeight": "1.15",
          "letterSpacing": "-0.02em",
          "fontWeight": "800"
        }
      ],
      "title-m": [
        "19px",
        {
          "lineHeight": "1.2",
          "letterSpacing": "-0.01em",
          "fontWeight": "800"
        }
      ],
      "button-l": [
        "22px",
        {
          "lineHeight": "1.0",
          "letterSpacing": "-0.02em",
          "fontWeight": "800"
        }
      ],
      "button-m": [
        "16px",
        {
          "lineHeight": "1.0",
          "letterSpacing": "0em",
          "fontWeight": "800"
        }
      ],
      "body-l": [
        "18px",
        {
          "lineHeight": "1.35",
          "letterSpacing": "0em",
          "fontWeight": "600"
        }
      ],
      "body": [
        "16px",
        {
          "lineHeight": "1.45",
          "letterSpacing": "0em",
          "fontWeight": "500"
        }
      ],
      "body-s": [
        "14px",
        {
          "lineHeight": "1.4",
          "letterSpacing": "0em",
          "fontWeight": "600"
        }
      ],
      "label": [
        "13px",
        {
          "lineHeight": "1.25",
          "letterSpacing": "0em",
          "fontWeight": "700"
        }
      ],
      "caption": [
        "12px",
        {
          "lineHeight": "1.3",
          "letterSpacing": "0.01em",
          "fontWeight": "700"
        }
      ],
      "hud-num": [
        "18px",
        {
          "lineHeight": "1.0",
          "letterSpacing": "-0.01em",
          "fontWeight": "800"
        }
      ]
    },
    "screens": {
      "md": "600px",
      "lg": "1024px",
      "xl": "1440px"
    },
    "extend": {
      "transitionDuration": {
        "press": "90ms",
        "quick": "160ms",
        "base": "240ms",
        "celebrate": "420ms"
      },
      "transitionTimingFunction": {
        "standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
        "pop": "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "exit": "cubic-bezier(0.4, 0, 1, 1)"
      },
      "zIndex": {
        "base": "0",
        "hud": "10",
        "sticky": "20",
        "nav": "30",
        "sheet": "40",
        "toast": "50",
        "modal": "60"
      }
    }
  }
};
