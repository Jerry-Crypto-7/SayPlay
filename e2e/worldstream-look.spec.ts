import { expect, test, type Page } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * Výtvarná brána (P15 T25) — **paleta se soudí na tom, co se doopravdy nakreslí**.
 *
 * `src/app/__tests__/theme.test.ts` už hlídá pásmo odstínu, ale čte **zdrojové
 * soubory**: `theme.css` a `UI_TOKENS`. Tím pádem nevidí barvu napsanou přímo
 * v komponentě — a těch je plno, `src/components/pipeline/Timeline.tsx` má
 * `#dceaec` i `rgba(12, 22, 26, 0.9)` v konstantách stylu. Fialová zavedená
 * tudy by prošla celou jednotkovou sadou. Tenhle soubor proto čte
 * `getComputedStyle` **každého vykresleného prvku**, ne zdroj.
 *
 * Druhá polovina je scéna: HTML může být čisté a svět fialový, protože barvy
 * geometrie jdou přes vrcholy a světla, ne přes CSS. Ta se soudí z pixelů, které
 * plátno vydalo (`window.__viewer.pixels()`).
 *
 * ## Proč pásmo odstínu, a ne seznam jmen
 *
 * Táž úvaha jako v `theme.test.ts`: seznam zakázaných hexů by ty hexy musel
 * obsahovat, a kontrola „nikde v repu není fialová" by pak padla sama na sobě.
 * Pásmo 250–320° je fialová až purpurová podle globálního pravidla.
 */

/** Odstín 0–360 z RGB. `null` pro šedé — jejich odstín nic neznamená. */
function hueOf(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span === 0) return null;

  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;

  return (((hue * 60) % 360) + 360) % 360;
}

/**
 * Sytost 0–1. Pod prahem je barva prakticky šedá a její odstín je šum
 * ze zaokrouhlení — u pixelů z rendereru jich jsou desítky tisíc.
 */
function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

const PURPLE_FROM = 250;
const PURPLE_TO = 320;

function isPurple(r: number, g: number, b: number, minSaturation: number): boolean {
  if (saturationOf(r, g, b) < minSaturation) return false;
  const hue = hueOf(r, g, b);
  return hue !== null && hue >= PURPLE_FROM && hue <= PURPLE_TO;
}

const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

async function buildWorld(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await openInspect(page);
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });
}

test('žádný vykreslený prvek rozhraní nenese fialový odstín', async ({ page }) => {
  test.setTimeout(180_000);
  // Se světem a s otevřeným Inspectem, tedy včetně pěti panelů potrubí —
  // zavřená zásuvka je doopravdy odpojí a nad prázdnou stránkou by se
  // nesoudilo skoro nic.
  await buildWorld(page);

  const guilty = await page.evaluate(
    ({ from, to }) => {
      const parse = (value: string): readonly [number, number, number] | null => {
        const found = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value);
        if (found === null) return null;
        // Průhledná barva se nekreslí, takže její odstín nikdo neuvidí.
        if (found[4] !== undefined && Number(found[4]) === 0) return null;
        return [Number(found[1]), Number(found[2]), Number(found[3])] as const;
      };

      const hue = (r: number, g: number, b: number): number | null => {
        const max = Math.max(r, g, b);
        const span = max - Math.min(r, g, b);
        if (span === 0) return null;
        let value: number;
        if (max === r) value = ((g - b) / span) % 6;
        else if (max === g) value = (b - r) / span + 2;
        else value = (r - g) / span + 4;
        return (((value * 60) % 360) + 360) % 360;
      };

      const properties = [
        'color',
        'backgroundColor',
        'borderTopColor',
        'borderRightColor',
        'borderBottomColor',
        'borderLeftColor',
        'outlineColor',
        'fill',
        'stroke',
      ] as const;

      const found: string[] = [];
      for (const element of Array.from(document.querySelectorAll('*'))) {
        const style = getComputedStyle(element);
        for (const property of properties) {
          const rgb = parse(style[property]);
          if (rgb === null) continue;
          const angle = hue(rgb[0], rgb[1], rgb[2]);
          if (angle === null || angle < from || angle > to) continue;
          const tag = element.tagName.toLowerCase();
          const id = element.getAttribute('data-testid') ?? '';
          found.push(`${tag}[${id}] ${property}=${style[property]}`);
        }
      }
      return found;
    },
    { from: PURPLE_FROM, to: PURPLE_TO },
  );

  expect(guilty, 'fialová ve vypočítaných barvách rozhraní').toEqual([]);
});

test('rozhraní si nestahuje žádné písmo, takže nemá co licencovat', async ({ page }) => {
  test.setTimeout(180_000);

  // Požadavek na písmo je vidět jedině na síti — `@font-face` může přijít
  // i z chunku, který se načte až s panelem.
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(url) || /fonts\.(googleapis|gstatic)\.com/.test(url)) {
      fontRequests.push(url);
    }
  });

  await buildWorld(page);

  expect(fontRequests, 'stažené písmo by muselo projít licenční bránou RULES.md §4').toEqual([]);

  const fonts = await page.evaluate(() => {
    const faces: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cizí origin. Žádný takový list tu nemá být, a kdyby byl, ohlásí ho
        // odchycený požadavek výš.
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSFontFaceRule) faces.push(rule.cssText);
      }
    }
    return { faces, body: getComputedStyle(document.body).fontFamily };
  });

  expect(fonts.faces, '@font-face znamená vlastní písmo, tedy licenci k doložení').toEqual([]);
  // Systémový zásobník je jediné, co se nikam nenahrává — proto není co hostovat
  // ani licencovat. Kdyby sem někdo dopsal jméno vlastního písma, spadne to tady.
  expect(fonts.body).toBe('ui-sans-serif, system-ui, sans-serif');
});

test('nakreslený svět nenese fialovou ani v pixelech', async ({ page }) => {
  test.setTimeout(240_000);

  for (const world of ['harbor-pier', 'dunes-terrace', 'frost-plateau']) {
    await page.goto(`/embed/${world}`);
    await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
    await page.waitForFunction(() => window.__viewer!.frames() > 3, undefined, { timeout: 60_000 });

    const shot = await page.evaluate(async () => window.__viewer!.pixels({ scale: 0.5 }));

    let purple = 0;
    const total = shot.width * shot.height;
    for (let at = 0; at < total; at += 1) {
      const base = at * 4;
      // Práh sytosti 0,15: pod ním je odstín šum ze zaokrouhlení a tmavé
      // pixely mlhy by hlásily fialovou, která na obrazovce není.
      if (isPurple(shot.data[base], shot.data[base + 1], shot.data[base + 2], 0.15)) purple += 1;
    }

    expect(total, `${world} nevydal žádné pixely`).toBeGreaterThan(0);
    // Nula by byla lež o zaokrouhlování: jeden pixel na hraně dvou odstínů se
    // do pásma trefit může. Tisícina plochy je pořád „na obrazovce fialová není".
    expect(purple / total, `podíl fialových pixelů v ${world}`).toBeLessThan(0.001);
  }
});
