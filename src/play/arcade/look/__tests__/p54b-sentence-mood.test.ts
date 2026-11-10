/**
 * Nálada, počasí a denní doba z celé věty (P54B T11). Špatně přečtená nálada vypadá
 * jako záměr – noc místo dne, déšť, který věta zapřela („no rain in sight“), bouřka
 * z přirovnání („punches like a thunderstorm“). Štítky 30 vět jsou zapsané ručně
 * před implementací: denní doba (`night` / `dusk`, úsvit a ráno = nízké teplé slunce
 * jako soumrak), počasí (`rain` / `snow` / `fog`) a nálada (`moodFor`).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Weather } from '@/components/play/arcade/Weather';
import type { ArcadeSession } from '@/components/play/arcade/session';
import { draftGameSpec } from '@/play/draft';

import { type Look, LOOKS, lookOf, moodFor, sceneLook, sentenceSky, timeOfDayFor, weatherFor } from '../index';
import { restyleLook, TODAY_STYLE } from '../style';

interface Label {
  readonly time?: 'night' | 'dusk';
  readonly weather?: 'rain' | 'snow' | 'fog';
  readonly mood?: 'spooky' | 'storm' | 'gloom' | 'fog' | 'bright' | 'dusk' | 'cozy';
}

const LABELLED: readonly (readonly [string, Label])[] = [
  ['a vampire hunts bats in a castle at midnight', { time: 'night' }],
  ['a fox races home through the forest at sunset', { time: 'dusk', mood: 'dusk' }],
  ['a witch brews potions in a crooked tower during a thunderstorm', { weather: 'rain', mood: 'storm' }],
  ['an owl delivers letters across a snowy mountain village', { weather: 'snow' }],
  ['a penguin slides home through a howling blizzard', { weather: 'snow' }],
  ['a ghost ship sails into a foggy harbour', { weather: 'fog', mood: 'fog' }],
  ['a lighthouse keeper guides boats on a misty evening', { time: 'dusk', weather: 'fog', mood: 'fog' }],
  ['a sleepy cat naps in a cozy rainy café', { weather: 'rain', mood: 'storm' }],
  ['a knight collects three keys in a haunted castle', { mood: 'spooky' }],
  ['a kid with a flashlight explores a spooky graveyard', { mood: 'spooky' }],
  ['an elf princess escapes a goblin castle through a dark forest', { mood: 'gloom' }],
  ['a dog catches frisbees on a sunny beach', { mood: 'bright' }],
  ['a bear bakes pancakes in a cozy cabin', { mood: 'cozy' }],
  ['a rooster wakes up the whole farm at dawn', { time: 'dusk' }],
  ['a jogger dodges puddles in the park in the early morning', { time: 'dusk' }],
  ['a robot sweeps the city streets in the evening rain', { time: 'dusk', weather: 'rain', mood: 'storm' }],
  // Zápor, přirovnání a metafora: světlo věta nejmenuje.
  ['a fox steals eggs from the farm, but not at night', {}],
  ['race buggies across the desert with no rain in sight', {}],
  ['a pirate captain dodges a storm of arrows on his ship', {}],
  ['a boxer punches like a thunderstorm in the ring', {}],
  ['a ninja sneaks through the dojo as silent as the night', {}],
  ['a happy bunny hops across a meadow that is never gloomy', {}],
  ['throw snowballs at kids hiding behind a snow fort', {}],
  ['a knight rides through the night to rescue a prince', { time: 'night' }],
  ['a chef flips pancakes in a busy kitchen', {}],
  ['a farmer harvests pumpkins on a foggy autumn morning', { time: 'dusk', weather: 'fog', mood: 'fog' }],
  ['zombies attack the city at night during a storm', { time: 'night', weather: 'rain', mood: 'storm' }],
  ['a dragon flies over a volcano under a starry night sky', { time: 'night' }],
  // „dark armor“ je barva brnění, ne šero místa.
  ['a knight in dark armor guards a sunny meadow', { mood: 'bright' }],
  ['a ghost hunter searches a creepy mansion on a stormy night', { time: 'night', weather: 'rain', mood: 'spooky' }],
];

/** Čtení věty proti štítkům: zásah = čtečka vrátila přesně štítek, falešný = vrátila něco jiného, než štítek říká. */
function score() {
  let hits = 0;
  let said = 0;
  let labelled = 0;
  const wrong: string[] = [];
  for (const [sentence, label] of LABELLED) {
    const read = { time: timeOfDayFor(sentence), weather: weatherFor(sentence), mood: moodFor(sentence) };
    for (const field of ['time', 'weather', 'mood'] as const) {
      const want = label[field] ?? null;
      const got = read[field];
      if (want !== null) labelled += 1;
      if (got !== null) said += 1;
      if (got !== null && got === want) hits += 1;
      if (got !== want) wrong.push(`${field}: ${String(got)} ≠ ${String(want)} – ${sentence}`);
    }
  }
  return { precision: hits / said, recall: hits / labelled, wrong };
}

/** Pole sady, která dělají světlo. */
const light = ({ sky, skyTop, horizon, light: hemisphere, sun, sunColor, glow, fog, exposure }: Look) => ({ sky, skyTop, horizon, hemisphere, sun, sunColor, glow, fog, exposure });

describe('P54B T11: nálada, počasí a denní doba z celé věty', () => {
  it('30 ručně označených vět: precision ≥ 0,95, recall ≥ 0,9', () => {
    expect(LABELLED).toHaveLength(30);
    const { precision, recall, wrong } = score();
    expect(precision, wrong.join('\n')).toBeGreaterThanOrEqual(0.95);
    expect(recall, wrong.join('\n')).toBeGreaterThanOrEqual(0.9);
  });

  // Souhrnná laťka snese jeden falešný zásah – stráže záporu, přirovnání a „dark armor“ proto každá zvlášť.
  it.each(LABELLED.filter(([sentence]) => /not at night|no rain|storm of|like a|as silent as|never gloomy|dark armor|snow fort/.test(sentence)))(
    'stráž věty drží přesně štítek: %s',
    (sentence, label) => {
      expect({ time: timeOfDayFor(sentence), weather: weatherFor(sentence), mood: moodFor(sentence) })
        .toEqual({ time: label.time ?? null, weather: label.weather ?? null, mood: label.mood ?? null });
    },
  );

  it('„storm“ jako sloveso není bouřka, „a sudden storm“ ano', () => {
    expect(weatherFor('knights storm the castle')).toBeNull();
    expect(moodFor('knights storm the castle')).toBeNull();
    expect(weatherFor('a sudden storm hits the castle')).toBe('rain');
  });

  it('útulná věta bez světla v místě je teplý soumrak; místo s vlastní náladou noc nepřidá', () => {
    expect(draftGameSpec('a bear bakes pancakes in a cozy cabin').theme.timeOfDay).toBe('dusk');
    expect(sentenceSky('a dark spooky tale', { setting: 'haunted castle', mood: '' }).timeOfDay).toBeUndefined();
  });

  it('návrh zapíše počasí a denní dobu z věty do theme a scéna je od prvního snímku ukáže', () => {
    const storm = draftGameSpec('a witch brews potions in a crooked tower during a thunderstorm').theme;
    expect(storm.weather).toBe('rain');
    const snowy = draftGameSpec('an owl delivers letters across a snowy mountain village').theme;
    expect(snowy.weather).toBe('snow');
    // Šero mimo místo věty („goblin castle“) uložené pole nemá; nese ho denní doba.
    const dark = draftGameSpec('an elf princess escapes a goblin castle through a dark forest').theme;
    expect(dark.timeOfDay).toBe('night');
    for (const theme of [storm, snowy, dark]) expect(light(sceneLook(theme)), theme.setting).not.toEqual(light(LOOKS[lookOf(theme)]));
    const weather = (theme: Parameters<typeof Weather>[0]['theme']) => renderToStaticMarkup(createElement(Weather, { session: {} as ArcadeSession, theme }));
    expect(weather(storm)).toContain('data-weather="rain"');
    expect(weather(snowy)).toContain('data-weather="snow"');
  });

  it('zápor a věta bez světla nic nezapíšou', () => {
    for (const sentence of ['a fox steals eggs from the farm, but not at night', 'a chef flips pancakes in a busy kitchen', 'race buggies across the desert with no rain in sight']) {
      const theme = draftGameSpec(sentence).theme;
      expect({ weather: theme.weather, timeOfDay: theme.timeOfDay }, sentence).toEqual({ weather: undefined, timeOfDay: undefined });
    }
  });

  it('stará uložená hra bez nových polí vypadá stejně jako dnes: nová slova v místě světlo nemění', () => {
    for (const theme of [
      { setting: 'a harbour at dawn', mood: 'calm' },
      { setting: 'thunderstorm city', mood: 'calm' },
      { setting: 'cozy cottage garden', mood: 'cozy' },
      { setting: 'snowy mountain village', mood: 'playful' },
      { setting: 'a farm in the early morning', mood: 'playful' },
      { setting: 'a lake at twilight', mood: 'calm' },
    ]) {
      // Profil před P81: světlo sady beze změny přebarvení (P81 přebarví každou sadu stejně, slova to nemění).
      expect(light(sceneLook(theme, TODAY_STYLE)), theme.setting).toEqual(light(LOOKS[lookOf(theme)]));
      expect(light(sceneLook(theme)), theme.setting).toEqual(light(restyleLook(LOOKS[lookOf(theme)], lookOf(theme), { night: false, overcast: false })));
    }
    // Slova, která sada četla už dřív, platí dál.
    expect(light(sceneLook({ setting: 'a stormy sea', mood: 'calm' }))).not.toEqual(light(LOOKS.ocean));
  });
});
