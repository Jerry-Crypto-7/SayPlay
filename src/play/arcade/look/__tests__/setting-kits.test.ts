/**
 * Sady nejčastějších světů (P57 T9). Pinuje se, co na snímku nikdo nepozná: svět s pár
 * kulisami vypadá jako „méně kulis“, ne jako chyba; id, které v katalogu není, tiše nic
 * nenakreslí; model se skóre pod 6 projde vizuálně jako „takový je styl“. A sady ostatních
 * světů se nesmí pohnout, i když je stavějí stejný skript.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog-index.json';

import { kitFor, LOOKS, withKit } from '../index';
import settingKits from '../setting-kits.json';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const usage = read('evals/play/p57/usage.json') as { settings: { setting: string }[] };
const judge = read('evals/play/p57/judge.json') as { models: Record<string, { score: number | null }> };
interface Judged { result: string; newScore: number | null; oldOpus?: number | null }
const regen = read('evals/play/p57/regen.json') as { models: Record<string, Judged> };
const top50 = (existsSync(join(ROOT, 'evals/play/p57/top50.json')) ? read('evals/play/p57/top50.json') : { models: {} }) as { models: Record<string, Judged> };
const PATHS: ReadonlyMap<string, string> = new Map(catalog.assets.map((asset) => [asset.assetId, asset.path]));

/** 10 nejčastějších světů z `usage.json` a pět, které audit jmenoval zvlášť. */
const WORLDS = [...new Set([...usage.settings.slice(0, 10).map((entry) => entry.setting), 'frozen lake', 'highway', 'supermarket', 'canyon', 'desert canyon'])];

/** Poslední soud modelu: výměna T8, výměna T6, přesouzení Opusem v T6, soud T4. */
function scoreOf(id: string): number | null {
  if (top50.models[id]?.result === 'replaced') return top50.models[id].newScore;
  if (regen.models[id]?.result === 'replaced') return regen.models[id].newScore;
  return regen.models[id]?.oldOpus ?? judge.models[id]?.score ?? null;
}

/** Řádek tabulky, který `kitFor` pro svět vybral (sada bez kitu → prázdný řádek). */
const kitEntryOf = (world: string) => settingKits.kits.find((kit) => kit.props.map((prop) => prop.id).join() === kitFor(world).join()) ?? { setting: world, look: 'meadow', props: [] };

describe('P57 T9: sady nejčastějších světů', () => {
  it('seznam má 15 světů bez duplicit', () => {
    expect(WORLDS).toHaveLength(15);
  });

  it.each(WORLDS)('%s: 15–25 různých kulis', (world) => {
    const ids = new Set(kitFor(world));
    expect(ids.size).toBeGreaterThanOrEqual(15);
    expect(ids.size).toBeLessThanOrEqual(25);
  });

  it('každá kulisa je v katalogu a její GLB leží v public/', () => {
    const ids = [...new Set(WORLDS.flatMap((world) => kitFor(world)))];
    expect(ids.filter((id) => !PATHS.has(id))).toEqual([]);
    expect(ids.filter((id) => PATHS.has(id) && !existsSync(join(ROOT, 'public', PATHS.get(id)!)))).toEqual([]);
  });

  it('žádná kulisa nemá poslední skóre pod 6', () => {
    const low = [...new Set(WORLDS.flatMap((world) => kitFor(world)))].filter((id) => (scoreOf(id) ?? 10) < 6).map((id) => `${id} ${scoreOf(id)}`);
    expect(low).toEqual([]);
  });

  it('řada kulis projde celou sadu: délka seznamu s kitem není násobek kroku 7 (`sceneryPlaces`)', () => {
    const stuck = WORLDS.filter((world) => withKit(LOOKS[kitEntryOf(world).look as keyof typeof LOOKS].props, kitFor(world)).length % 7 === 0);
    expect(stuck).toEqual([]);
  });

  it('kulisa sady P57 má v celé tabulce jednu výšku (`KIT_HEIGHTS` bere poslední výskyt, jinak by se pohnul i cizí svět)', () => {
    const heights = new Map<string, Set<number>>();
    for (const kit of settingKits.kits) for (const prop of kit.props) heights.set(prop.id, (heights.get(prop.id) ?? new Set()).add(prop.height));
    const ours = new Set(WORLDS.flatMap((world) => kitFor(world)));
    expect([...heights].filter(([id, set]) => ours.has(id as never) && set.size > 1).map(([id]) => id)).toEqual([]);
  });

  it('sady světů mimo seznam jsou bajtově shodné s tabulkou před P57', () => {
    const ours = new Set(WORLDS.map(kitEntryOf));
    const rest = settingKits.kits.filter((kit) => !ours.has(kit));
    expect(rest).toHaveLength(92);
    expect(createHash('sha256').update(JSON.stringify(rest)).digest('hex')).toBe('e05cbdd547954d3cfd4da4e416ed3506fd61f8a4ad0669b1eadc473e89496dce');
  });
});
