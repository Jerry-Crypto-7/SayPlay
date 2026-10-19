#!/usr/bin/env node
/**
 * Sčítání scény P54B: kolik toho scéna rychlé verze (návrh bez režiséra) kreslí.
 * Každá věta dev sady (`evals/play/p30/dev.json`) projde `draftGameSpec` →
 * `heroModel` / `enemyModel` / `chaserModel` / `propModels` → `sceneLook`
 * (rekvizity sady `landmarks`, druhy vegetace `floraIds`). Počítá:
 *
 * - hrdinu a nepřítele s kostrou (`riggedCharacter`) – postava s klipy, ne socha,
 * - odlišné modely ve scéně: obsazení + rekvizity sady + vegetace,
 * - jestli sada změnila světlo (obloha, polokoule, slunce, záře, mlha) proti své
 *   výchozí podobě, a jestli věta světlo jmenuje (noc, bouřka, mlha, strašidelně…).
 *
 * Věta, která mimo prohlížeč spadne (míč potřebuje `loadRapier()`), se zapíše
 * jako `skipped`, ne chyba. Čísla jsou čistá funkce kódu – žádný čas v souboru.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/play-scene-census.mjs --out evals/play/p54b/census-before.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chaserModel, enemyModel, heroModel, propModels, riggedCharacter } from '@/play/arcade/models';
import { LOOKS, floraIds, landmarks, lookOf, sceneLook } from '@/play/arcade/look';
import { draftGameSpec } from '@/play/draft';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Věta, která o světle něco říká: denní doba, počasí, nálada. */
export const NAMES_LIGHT = /\b(?:night|nighttime|midnight|sunset|sundown|dusk|evening|twilight|dawn|sunrise|morning|thunderstorm|storm|stormy|rain|rainy|raining|snowy|snowing|snowstorm|blizzard|fog|foggy|mist|misty|cozy|spooky|haunted|creepy|sunny|dark|darkness|gloomy)\b/i;

/** Pole sady, která dělají světlo – ne zem, rekvizity ani povrch. */
const LIGHT_FIELDS = ['sky', 'skyTop', 'horizon', 'light', 'sun', 'sunColor', 'glow', 'fog', 'exposure'];

const lightChanged = (look, base) => LIGHT_FIELDS.some((field) => JSON.stringify(look[field]) !== JSON.stringify(base[field]));

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];

const share = (count, of) => ({ count, of, share: of === 0 ? 0 : Math.round((count / of) * 1000) / 1000 });

export function census(sentences) {
  const rows = [];
  const skipped = [];
  for (const sentence of sentences) {
    let spec;
    try {
      spec = draftGameSpec(sentence.text, 1);
    } catch (error) {
      skipped.push({ id: sentence.id, text: sentence.text, reason: String(error?.message ?? error).slice(0, 160) });
      continue;
    }
    const look = sceneLook(spec.theme);
    const lookId = lookOf(spec.theme);
    const hero = heroModel(spec);
    const enemy = enemyModel(spec);
    const cast = [...new Set([hero, enemy, chaserModel(spec), ...Object.values(propModels(spec))])];
    const scenery = [...new Set(landmarks(look))];
    const flora = look.flora === undefined ? [] : [...floraIds(look.flora)];
    rows.push({
      id: sentence.id,
      text: sentence.text,
      look: lookId,
      genre: spec.genre?.id ?? spec.control,
      hero,
      heroRigged: riggedCharacter(hero) !== undefined,
      enemy,
      enemyRigged: riggedCharacter(enemy) !== undefined,
      cast,
      scenery,
      flora,
      distinct: new Set([...cast, ...scenery, ...flora]).size,
      lightChanged: lightChanged(look, LOOKS[lookId]),
      namesLight: NAMES_LIGHT.test(sentence.text),
    });
  }
  const distinct = rows.map((row) => row.distinct);
  const named = rows.filter((row) => row.namesLight);
  const count = (pick) => rows.filter(pick).length;
  const tally = (key) => Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row[key])).map(([name, group]) => [name, group.length]).sort((a, b) => b[1] - a[1]));
  return {
    measured: rows.length,
    skipped,
    heroRigged: share(count((row) => row.heroRigged), rows.length),
    enemyRigged: share(count((row) => row.enemyRigged), rows.length),
    distinct: { median: median(distinct), min: Math.min(...distinct), max: Math.max(...distinct) },
    lightChanged: share(count((row) => row.lightChanged), rows.length),
    namesLight: { count: named.length, lit: named.filter((row) => row.lightChanged).length, missing: named.filter((row) => !row.lightChanged).map((row) => row.id) },
    byLook: tally('look'),
    byGenre: tally('genre'),
    rows,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const at = process.argv.indexOf('--out');
  const out = at === -1 ? null : process.argv[at + 1];
  const dev = JSON.parse(readFileSync(join(ROOT, 'evals', 'play', 'p30', 'dev.json'), 'utf8')).sentences;
  const report = {
    about: 'P54B scene census: dev set (evals/play/p30/dev.json) through draftGameSpec (fast version, no director). distinct = cast (hero, enemy, chaser, props) + setting scenery (landmarks) + vegetation species. lightChanged = sceneLook differs from the setting default in sky, light, sun, glow, fog or exposure. namesLight = the sentence names time of day, weather or mood. Rigged = model with a skeleton and clips (riggedCharacter).',
    set: 'evals/play/p30/dev.json',
    ...census(dev),
  };
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify(summary, null, 1));
  if (out !== null) writeFileSync(resolve(ROOT, out), `${JSON.stringify(report, null, 1)}\n`);
}
