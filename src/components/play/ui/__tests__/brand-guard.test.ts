import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Stráž stylu kitu Sayplay (P34 T2). Surový hex, rozmazaný stín nebo náklon
 * mimo kit vypadá na snímku skoro dobře a tiše rozbije jednotný vzhled –
 * tenhle test běží při každé budoucí změně UI a padne na:
 * surový hex, `rgb()`/`rgba()`, `backdrop-filter`, stín s rozostřením,
 * `text-transform: uppercase`, dlouhou pomlčku a `rotate` mimo třídy, které
 * kit naklání. Barvy jen `var(--sp-…)` z `src/brand/tokens.css`
 * (`docs/brand/REPO-NOTES.md`).
 */

const ROOT = process.cwd();
const CSS_FILE = 'src/app/play/play.css';
const TSX_DIR = 'src/components/play';
const CSS = readFileSync(join(ROOT, CSS_FILE), 'utf-8');
const TOKENS = readFileSync(join(ROOT, 'src/brand/tokens.css'), 'utf-8');
const KIT = readFileSync(join(ROOT, 'docs/brand/components/sayplay.css'), 'utf-8');

/**
 * Soubory, které kreslí 3D scénu (three.js, plátno): jejich barvy patří
 * scéně (stopy A, C, E), ne rozhraní. Nový soubor scény sem patří jen tehdy,
 * když barvy nejdou vzít z `colorHex` v `src/brand/tokens.ts`.
 */
const SCENE_FILES = new Set([
  'OrderBubbles.tsx',
  'PatrolSight.tsx',
  'arcade/ArcadeStage.tsx',
  // Maska částic na plátně potřebuje bílou s průhledností (rgba), token nese jen barvu.
  'arcade/effects/Effects.tsx',
  // Varování průběhu (P45C T15): barvy z `colorHex`, ale geometrie položená na zem (`rotateX`) – `rotate` three.js, ne CSS.
  'arcade/effects/PacingFx.tsx',
  'arcade/World.tsx',
  // Podklad vyčleněný z `World.tsx` (P46G T7) – čáry drah nesou barvu přímo jako dřív.
  'arcade/WorldBackdrop.tsx',
  'arcade/arena/ArenaScene.tsx',
  'arcade/duel/DuelScene.tsx',
  // Scéna minigolfu (P68-L T3): tečky stopy míření položené na trávník (`rotateX`) – `rotate` three.js, ne CSS.
  'arcade/genres/minigolf/MinigolfScene.tsx',
  'arcade/look/Scenery.tsx',
  // Scéna skákačky (P46G): břeh v písku míchá zem s bílou jako ostatní terén (`islands.ts`, `water.ts`).
  'arcade/platform/PlatformWorld.tsx',
  'arcade/rhythm/RhythmScene.tsx',
  'arcade/shooter/ShooterRig.tsx',
  'arcade/shooter/primitives.tsx',
  'arcade/steer/SteerScene.tsx',
  'arcade/throw/ThrowRig.tsx',
  'arcade/timing/TimingScene.tsx',
]);

/** Náklon kit dovoluje jen kartám nápadů, odznaku výhry, štítku ve světě a zvýrazněnému slovu. */
const TILTED = ['.sp-highlight', '.sp-tilt-l', '.sp-tilt-r', '.sp-idea', '.sp-world-tag', '.sp-badge'];
const TILT_KEYFRAMES = ['sp-spin'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

const TSX = tsxFiles(join(ROOT, TSX_DIR)).map((path) => ({
  name: relative(join(ROOT, TSX_DIR), path).replaceAll('\\', '/'),
  source: readFileSync(path, 'utf-8'),
}));

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Řádek (od 1), na kterém leží znak `index` – ať hláška řekne, kde hledat. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Řádky se shodou, každý jednou. */
function hits(source: string, pattern: RegExp): number[] {
  return [...new Set([...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((m) => lineOf(source, m.index)))];
}

/** Rozdělí hodnotu podle čárek mimo závorky: `a, b(c, d)` → `a`, `b(c, d)`. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') depth -= 1;
    else if (value[i] === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Má stín rozostření? Barvy (`var()`, `color-mix()`) pryč, třetí délka je rozostření. */
function blurredShadow(value: string): boolean {
  return splitTop(value).some((shadow) => {
    if (/^(none|var\([^()]*\))$/.test(shadow)) return false;
    const lengths = shadow
      .replace(/(var|color-mix|rgba?|hsla?)\((?:[^()]|\([^()]*\))*\)/g, ' ')
      .replace(/\binset\b/g, ' ')
      .match(/-?\d*\.?\d+[a-z%]*/g);
    return lengths !== null && lengths.length >= 3 && Number.parseFloat(lengths[2]) !== 0;
  });
}

type Check = (source: string) => number[];

const CSS_CHECKS: Record<string, Check> = {
  'raw hex': (css) => hits(stripComments(css), /#[0-9a-fA-F]{3,8}\b/),
  'rgb() or rgba()': (css) => hits(stripComments(css), /\b(rgba?|hsla?)\(/),
  'backdrop-filter or blur()': (css) => hits(stripComments(css), /backdrop-filter|\bblur\(|drop-shadow\(/),
  'blurred shadow': (css) => {
    const own = stripComments(css);
    return [...own.matchAll(/(box-shadow|text-shadow|--[\w-]*shadow[\w-]*)\s*:\s*([^;{}]+)/g)]
      .filter((m) => blurredShadow(m[2]))
      .map((m) => lineOf(own, m.index));
  },
  'text-transform: uppercase': (css) => hits(stripComments(css), /text-transform\s*:\s*uppercase/),
  'em dash': (css) => hits(css, /—/),
  'rotate outside the tilted kit classes': (css) => rotateOutsideKit(stripComments(css)),
  'old --play-* or --p-* token': (css) => hits(css, /--(play|p)-[a-z]/),
};

/** `rotate` smí stát jen v pravidle nakloněné třídy kitu nebo v `@keyframes sp-spin`. */
function rotateOutsideKit(css: string): number[] {
  const bad: number[] = [];
  const stack: string[] = [];
  let header = 0;
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char === '{') {
      stack.push(css.slice(header, i).trim());
      header = i + 1;
    } else if (char === '}') {
      stack.pop();
      header = i + 1;
    } else if (char === ';') {
      header = i + 1;
    } else if (/^rotate[XYZ3d]*\s*[(:]/.test(css.slice(i, i + 12)) && !/[\w-]/.test(css[i - 1] ?? '')) {
      const inKeyframes = stack.some((head) => TILT_KEYFRAMES.some((name) => head === `@keyframes ${name}`));
      const selectors = splitTop(stack.at(-1) ?? '');
      const tilted = selectors.length > 0 && selectors.every((selector) => TILTED.some((cls) => new RegExp(`${cls.replace('.', '\\.')}(?![\\w-])`).test(selector)));
      if (!inKeyframes && !tilted) bad.push(lineOf(css, i));
    }
  }
  return bad;
}

const TSX_CHECKS: Record<string, (source: string, scene: boolean) => number[]> = {
  'raw hex': (source, scene) => (scene ? [] : hits(source, /['"`\s:(,]#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/)),
  'rgb() or rgba()': (source, scene) => (scene ? [] : hits(source, /\b(rgba?|hsla?)\(/)),
  'backdrop-filter or blur()': (source) => hits(source, /backdropFilter|backdrop-filter|\bblur\(/),
  'blurred shadow': (source) =>
    [...source.matchAll(/(boxShadow|textShadow|box-shadow|text-shadow)\s*:\s*['"`]([^'"`]+)['"`]/g)].filter((m) => blurredShadow(m[2])).map((m) => lineOf(source, m.index)),
  'text-transform: uppercase': (source) => hits(source, /textTransform\s*:\s*['"`]uppercase|text-transform\s*:\s*uppercase/),
  'em dash': (source) => hits(source, /—/),
  'rotate outside the tilted kit classes': (source, scene) => (scene ? [] : hits(source, /\brotate(?:[XYZ]|3d)?\(|\brotate\s*:\s*['"`]/)),
  'old --play-* or --p-* token': (source) => hits(source, /--(play|p)-[a-z]/),
};

describe('brand guard – play.css', () => {
  for (const [name, check] of Object.entries(CSS_CHECKS)) {
    it(`has no ${name}`, () => {
      expect(check(CSS).map((line) => `${CSS_FILE}:${String(line)}`)).toEqual([]);
    });
  }
});

describe('brand guard – src/components/play/**/*.tsx', () => {
  it('reads the play components', () => {
    expect(TSX.length).toBeGreaterThan(20);
    for (const scene of SCENE_FILES) expect(TSX.some((file) => file.name === scene), `${scene} no longer exists – drop it from SCENE_FILES`).toBe(true);
  });

  for (const [name, check] of Object.entries(TSX_CHECKS)) {
    it(`has no ${name}`, () => {
      const found = TSX.flatMap((file) => check(file.source, SCENE_FILES.has(file.name)).map((line) => `${TSX_DIR}/${file.name}:${String(line)}`));
      expect(found).toEqual([]);
    });
  }
});

describe('brand guard – the checks themselves', () => {
  // Každý zakázaný vzor jednou: stráž, která ho nevidí, je dekorace.
  const BAD_CSS = [
    '.a { color: #ff00aa; }',
    '.a { color: rgb(1 2 3); }',
    '.a { backdrop-filter: blur(4px); }',
    '.a { box-shadow: 0 2px 8px var(--sp-color-ink); }',
    '.a { text-transform: uppercase; }',
    '.a::after { content: "—"; }',
    '.a { transform: rotate(3deg); }',
    '.a { color: var(--play-text); }',
  ];

  it('catches every forbidden pattern in CSS, each by its own check', () => {
    Object.values(CSS_CHECKS).forEach((check, index) => {
      expect(check(BAD_CSS[index]).length, BAD_CSS[index]).toBe(1);
    });
  });

  it('lets through what the kit allows', () => {
    const fine = [
      '.a { box-shadow: var(--sp-shadow-md); }',
      '.a { box-shadow: 0 0 0 7px var(--sp-color-sun); }',
      '.a { box-shadow: 5px 5px 0 0 var(--sp-color-ink); }',
      '.sp-idea:active { transform: rotate(0deg) scale(0.97); }',
      '.sp-world-tag { transform: translate(-50%, -100%) rotate(-4deg); }',
      '@keyframes sp-spin { to { transform: rotate(360deg); } }',
      '.a { background: color-mix(in srgb, var(--sp-color-ink) 45%, transparent); }',
    ].join('\n');
    for (const check of Object.values(CSS_CHECKS)) expect(check(fine)).toEqual([]);
  });

  it('does not let a tilted class shield an untilted one in the same rule', () => {
    expect(rotateOutsideKit('.sp-idea, .play-hud { transform: rotate(2deg); }')).toEqual([1]);
    expect(rotateOutsideKit('.sp-ideas { transform: rotate(2deg); }')).toEqual([1]);
  });

  it('catches every forbidden pattern in a component', () => {
    const bad = [
      "<p style={{ color: '#fff' }} />",
      "<p style={{ color: 'rgba(0, 0, 0, 0.5)' }} />",
      "<p style={{ backdropFilter: 'blur(8px)' }} />",
      "<p style={{ boxShadow: '0 4px 12px black' }} />",
      "<p style={{ textTransform: 'uppercase' }} />",
      '<p>Make it — now</p>',
      "<p style={{ transform: 'rotate(4deg)' }} />",
      "<p style={{ color: 'var(--p-text)' }} />",
    ];
    Object.values(TSX_CHECKS).forEach((check, index) => {
      expect(check(bad[index], false).length, bad[index]).toBe(1);
    });
    expect(TSX_CHECKS['raw hex']('<use href="/brand/icons/sprite.svg#sp-mic" />', false)).toEqual([]);
  });
});

describe('play.css – the kit, class by class', () => {
  const own = stripComments(CSS);

  it('ports every class and keyframe of the kit stylesheet (avatar excepted: no accounts)', () => {
    const kitClasses = new Set(stripComments(KIT).match(/\.sp-[a-z0-9_-]+/g));
    kitClasses.delete('.sp-avatar');
    const missing = [...kitClasses].filter((cls) => !new RegExp(`${cls.replace('.', '\\.')}(?![\\w-])`).test(own));
    expect(missing).toEqual([]);
    for (const [, name] of KIT.matchAll(/@keyframes\s+([\w-]+)/g)) expect(own).toContain(`@keyframes ${name}`);
    expect(own).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sp-root \*/);
  });

  it('gives every button, chip and card the 44 px tap height, and HUD buttons 50 px', () => {
    const size = (name: string) => Number.parseFloat(new RegExp(`--sp-size-${name}:\\s*([\\d.]+)px`).exec(TOKENS)?.[1] ?? 'NaN');
    for (const name of ['touch-min', 'control-s', 'control-m', 'control-l']) expect(size(name), name).toBeGreaterThanOrEqual(44);
    expect(size('hud-pill')).toBeGreaterThanOrEqual(50);

    const rules = [...own.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: splitTop(m[1].trim()), body: m[2] }));
    const TAP = /min-height:\s*var\(--sp-size-(touch-min|control-[sml])\)/;
    for (const selector of [':where(.play-button)', '.sp-btn', '.sp-btn--m', '.sp-btn--s', '.sp-btn--icon', '.sp-btn--link', '.sp-chip', '.play-target', '.play-pager-step']) {
      expect(rules.some((rule) => rule.selectors.includes(selector) && TAP.test(rule.body)), `${selector} has no 44 px min-height`).toBe(true);
    }
    // Karta nápadu (P34 T3) má výšku z kitu v pixelech, ne z tokenu.
    const idea = rules.find((rule) => rule.selectors.includes('.sp-idea') && /min-height:/.test(rule.body));
    expect(Number.parseFloat(/min-height:\s*([\d.]+)px/.exec(idea?.body ?? '')?.[1] ?? 'NaN')).toBeGreaterThanOrEqual(44);
    expect(rules.some((rule) => rule.selectors.includes('.sp-hud-btn') && /height:\s*var\(--sp-size-hud-pill\)/.test(rule.body))).toBe(true);
  });
});
