#!/usr/bin/env node
/**
 * Tokeny Sayplay: `docs/brand/tokens/tokens.json` → `src/brand/tokens.css` a
 * `src/brand/tokens.ts` (P34 T1).
 *
 *   node scripts/brand/tokens.mjs
 *
 * Zdroj pravdy je JSON z kitu. Oba výstupy se jen generují, ručně se needitují;
 * `src/brand/__tests__/tokens.test.ts` je vygeneruje znovu a porovná s diskem.
 *
 * Jediná odchylka od kitu jsou písma (`docs/brand/REPO-NOTES.md`): Bricolage a
 * Figtree jsou pod OFL, repo smí jen Apache-2.0, takže obě rodiny jsou Roboto
 * v2.138 a váhy se mapují na řezy, které Roboto má.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE = 'docs/brand/tokens/tokens.json';
export const CSS_OUT = 'src/brand/tokens.css';
export const TS_OUT = 'src/brand/tokens.ts';

export const FONT_STACK = "'Roboto', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** Váha z kitu → řez Roboto. Nadpisy 900, text 500 a 700 (Roboto nemá 600 ani 800). */
export const WEIGHT_MAP = {
  display: { 800: 900 },
  body: { 500: 500, 600: 500, 700: 700, 800: 700 },
};

/** Sémantické aliasy z `docs/brand/tokens/tokens.css`. V JSON nejsou, kit je píše ručně. */
const ALIASES = [
  ['bg', 'cream'],
  ['surface', 'paper'],
  ['surface-pressed', 'cream-deep'],
  ['text', 'ink'],
  ['text-secondary', 'ink-soft'],
  ['text-placeholder', 'ink-faint'],
  ['outline', 'ink'],
  ['primary', 'tomato'],
  ['on-primary', 'ink'],
  ['secondary', 'sun'],
  ['on-secondary', 'ink'],
  ['danger', 'alarm'],
  ['success', 'grass'],
  ['focus', 'ink'],
];

const HEADER = 'Sayplay design tokens v1.0, generated from docs/brand/tokens/tokens.json by scripts/brand/tokens.mjs. Do not edit by hand.';

const px = (value) => Number(String(value).replace(/px$/, ''));
const cssKey = (key) => key.replace('.', '_');
const familyOf = (ref) => (ref.includes('display') ? 'display' : 'body');

function weightOf(family, weight) {
  const mapped = WEIGHT_MAP[family][weight];
  if (mapped === undefined) throw new Error(`tokens.json: no Roboto cut for ${family} weight ${weight}`);
  return mapped;
}

function typographyEntries(json) {
  return Object.entries(json.typography).map(([name, { $value: t }]) => {
    const family = familyOf(t.fontFamily);
    return {
      name,
      family,
      size: px(t.fontSize),
      sizeDesktop: px(t.fontSizeDesktop),
      weight: weightOf(family, t.fontWeight),
      lineHeight: t.lineHeight,
      letterSpacingEm: Number(String(t.letterSpacing).replace(/em$/, '')),
    };
  });
}

/** Barva stínu jako odkaz na token, pokud v paletě je. Surový hex jen v definicích barev. */
function shadowCss(value, colors) {
  if (value === 'none') return 'none';
  const token = Object.entries(colors).find(([, hex]) => hex.toLowerCase() === value.color.toLowerCase());
  const color = token ? `var(--sp-color-${token[0]})` : value.color;
  return `${value.offsetX} ${value.offsetY} ${px(value.blur)} ${px(value.spread)} ${color}`;
}

const bezier = (points) => `cubic-bezier(${points.join(', ')})`;

export function renderCss(json) {
  const colors = Object.fromEntries(Object.entries(json.color).map(([k, v]) => [k, v.$value]));
  const type = typographyEntries(json);
  const lines = [`/* ${HEADER} */`, ':root {', '  /* Color */'];
  for (const [name, token] of Object.entries(json.color)) {
    lines.push(`  --sp-color-${name}: ${token.$value}; /* ${token.$description} */`);
  }
  lines.push('', '  /* Semantic aliases, use these in components */');
  for (const [alias, name] of ALIASES) lines.push(`  --sp-${alias}: var(--sp-color-${name});`);
  lines.push('', '  /* Space (4px base) */');
  for (const [key, token] of Object.entries(json.space)) lines.push(`  --sp-space-${cssKey(key)}: ${token.$value};`);
  lines.push('', '  /* Radius */');
  for (const [key, token] of Object.entries(json.radius)) lines.push(`  --sp-radius-${key}: ${token.$value};`);
  lines.push('', '  /* Border */');
  for (const [key, token] of Object.entries(json['border-width'])) lines.push(`  --sp-border-${key}: ${token.$value};`);
  lines.push('', '  /* Hard shadow (never blurred) */');
  for (const [key, token] of Object.entries(json.shadow)) lines.push(`  --sp-shadow-${key}: ${shadowCss(token.$value, colors)};`);
  lines.push('', '  /* Type: Roboto v2.138 for both kit families (docs/brand/REPO-NOTES.md) */');
  lines.push(`  --sp-font-display: ${FONT_STACK};`, `  --sp-font-body: ${FONT_STACK};`);
  for (const t of type) {
    lines.push(
      `  --sp-text-${t.name}-size: ${t.size}px; --sp-text-${t.name}-weight: ${t.weight}; ` +
        `--sp-text-${t.name}-leading: ${t.lineHeight}; --sp-text-${t.name}-tracking: ${t.letterSpacingEm}em;`,
    );
  }
  lines.push('', '  /* Motion */');
  for (const [key, token] of Object.entries(json.duration)) lines.push(`  --sp-duration-${key}: ${token.$value};`);
  for (const [key, token] of Object.entries(json.easing)) lines.push(`  --sp-ease-${key}: ${bezier(token.$value)};`);
  lines.push('', '  /* Layering */');
  for (const [key, token] of Object.entries(json['z-index'])) lines.push(`  --sp-z-${key}: ${token.$value};`);
  lines.push('', '  /* Sizes */');
  for (const [key, token] of Object.entries(json.size)) lines.push(`  --sp-size-${key}: ${token.$value};`);
  lines.push('}', '');

  const desktop = type.filter((t) => t.sizeDesktop !== t.size);
  lines.push(`/* Desktop type scale (>= ${json.breakpoint.lg.$value}) */`);
  lines.push(`@media (min-width: ${json.breakpoint.lg.$value}) {`, '  :root {');
  for (const t of desktop) lines.push(`    --sp-text-${t.name}-size: ${t.sizeDesktop}px;`);
  lines.push('  }', '}', '');

  const zero = Object.keys(json.duration).map((key) => `--sp-duration-${key}: 0ms;`).join(' ');
  lines.push('@media (prefers-reduced-motion: reduce) {', `  :root { ${zero} }`, '}', '');
  return lines.join('\n');
}

const pretty = (value) => JSON.stringify(value, null, 2);

export function renderTs(tokens) {
  const colors = Object.fromEntries(Object.entries(tokens.color).map(([k, v]) => [k, v.$value]));
  const numbers = (group) => Object.fromEntries(Object.entries(group).map(([k, v]) => [k, px(v.$value)]));
  const typography = Object.fromEntries(
    typographyEntries(tokens).map(({ name, ...rest }) => [name, rest]),
  );
  const shadow = Object.fromEntries(
    Object.entries(tokens.shadow).map(([k, v]) => [
      k,
      v.$value === 'none' ? 'none' : `${v.$value.offsetX} ${v.$value.offsetY} ${px(v.$value.blur)} ${px(v.$value.spread)} ${v.$value.color}`,
    ]),
  );
  const motion = {
    duration: numbers(tokens.duration),
    easing: Object.fromEntries(Object.entries(tokens.easing).map(([k, v]) => [k, bezier(v.$value)])),
  };
  const hexLines = Object.entries(colors).map(([k, v]) => `  ${JSON.stringify(k)}: 0x${v.slice(1).toUpperCase()},`);

  return [
    `/* ${HEADER} */`,
    '',
    `export const color = ${pretty(colors)} as const;`,
    '',
    `export const space = ${pretty(numbers(tokens.space))} as const;`,
    '',
    `export const radius = ${pretty(numbers(tokens.radius))} as const;`,
    '',
    `export const borderWidth = ${pretty(numbers(tokens['border-width']))} as const;`,
    '',
    `export const shadow = ${pretty(shadow)} as const;`,
    '',
    `export const fontFamily = ${pretty({ display: FONT_STACK, body: FONT_STACK })} as const;`,
    '',
    `export const typography = ${pretty(typography)} as const;`,
    '',
    `export const motion = ${pretty(motion)} as const;`,
    '',
    `export const breakpoint = ${pretty(numbers(tokens.breakpoint))} as const;`,
    '',
    `export const zIndex = ${pretty(Object.fromEntries(Object.entries(tokens['z-index']).map(([k, v]) => [k, v.$value])))} as const;`,
    '',
    `export const size = ${pretty(numbers(tokens.size))} as const;`,
    '',
    '/** Numeric hex (0xRRGGBB) for three.js and other engines. */',
    'export const colorHex = {',
    ...hexLines,
    '} as const;',
    '',
  ].join('\n');
}

export function readSource(root = process.cwd()) {
  return JSON.parse(readFileSync(join(root, SOURCE), 'utf8'));
}

export function generate(root = process.cwd()) {
  const source = readSource(root);
  const css = renderCss(source);
  const ts = renderTs(source);
  writeFileSync(join(root, CSS_OUT), css);
  writeFileSync(join(root, TS_OUT), ts);
  return { css, ts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  generate();
  console.log(`tokens: ${CSS_OUT}, ${TS_OUT}`);
}
