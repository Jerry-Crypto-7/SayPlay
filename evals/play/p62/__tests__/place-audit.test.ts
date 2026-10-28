/**
 * Audit místa P62 (T9): štítky jsou ruční data a počet špatných míst je číslo, podle kterého opravuje T10. Audit,
 * který nepočítá ze štítků (ručně upravený výsledek, věta bez štítku, štítek s neexistující sadou), dá T10 falešný
 * cíl; audit, který přečte zapečetěnou sadu B, z brány T12 udělá měření na tréninkových větách.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOOK_IDS } from '../../../../src/play/arcade/look';
import { labelsById, openSentences, placeAuditSets, placeClass, placeRow, type PlaceRow, type PlaceSummary, summarizePlaces } from '../place-audit.mjs';

const DIR = join(process.cwd(), 'evals', 'play', 'p62');
const audit = (): { sets: string[]; summary: PlaceSummary; rows: PlaceRow[] } => JSON.parse(readFileSync(join(DIR, 'place-audit.json'), 'utf8'));

describe('P62 place audit', () => {
  it('reads the open sets only, never sealed set B', () => {
    expect(placeAuditSets()).not.toContain('p62/holdout-b.json');
    expect(placeAuditSets()).toEqual(expect.arrayContaining(['p30/dev.json', 'p58b/holdout.json', 'p61/holdout.json', 'p62/holdout.json']));
    expect(audit().sets).toEqual(placeAuditSets());
  });

  it('labels every open sentence once, with existing looks, and no look list without a place', () => {
    const labels = labelsById();
    expect([...labels.keys()].sort()).toEqual(openSentences().map((s) => s.id).sort());
    for (const label of labels.values()) {
      expect(label.ok.filter((look) => !(LOOK_IDS as readonly string[]).includes(look)), label.id).toEqual([]);
      expect(label.place === null ? label.ok.length === 0 : label.ok.length > 0, label.id).toBe(true);
    }
  });

  it('gives a wrong place the first class that fits', () => {
    expect(placeClass({ id: 'a', place: 'night market', ok: ['city'] }, 'supermarket')).toBe('compound');
    expect(placeClass({ id: 'b', place: 'post office sorting room', ok: ['city', 'factory'] }, 'living_room')).toBe('compound');
    // Místo, které žádná sada nezná (fotbalové hřiště zná od T10 louka).
    expect(placeClass({ id: 'c', place: 'bowling alley', ok: ['city'] }, 'castle')).toBe('foreign-interior');
    expect(placeClass({ id: 'd', place: 'haunted castle', ok: ['castle', 'graveyard'] }, 'meadow')).toBe('overridden');
    expect(placeClass({ id: 'e', place: 'circus', ok: ['meadow', 'city'] }, 'beach', 'Bounce a beach ball on a seal’s nose at the circus')).toBe('overridden');
    // Místa, která žádná sada nezná (cirkus a kavárnu zná od T10 louka a obývák).
    expect(placeClass({ id: 'h', place: 'zoo', ok: ['meadow', 'city'] }, 'beach', 'Juggle on a seal’s nose at the zoo')).toBe('unknown-place');
    expect(placeClass({ id: 'i', place: 'bistro', ok: ['living_room', 'city'] }, 'meadow', 'a sleepy cat naps in a cozy rainy bistro')).toBe('unknown-place');
    expect(placeClass({ id: 'j', place: 'tower', ok: ['city', 'castle'] }, 'meadow', 'A firefighter climbs the tower')).toBe('overridden');
    expect(placeClass({ id: 'k', place: 'harbour', ok: ['beach'] }, 'meadow', 'a crab sneaks around the harbour')).toBe('other');
    expect(placeClass({ id: 'f', place: 'night market', ok: ['city'] }, 'city')).toBeNull();
    expect(placeClass({ id: 'g', place: null, ok: [] }, 'castle')).toBeNull();
  });

  it('records rows and counts that follow from the labels and the drawn look', () => {
    const labels = labelsById();
    const { rows, summary } = audit();
    expect(rows.map((row) => [row.id, row.text])).toEqual(openSentences().map((s) => [s.id, s.text]));
    for (const row of rows) {
      const again = placeRow(row, labels.get(row.id)!, row.drawn);
      expect([row.place, row.ok, row.verdict, row.class ?? null], row.id).toEqual([again.place, again.ok, again.verdict, again.class ?? null]);
    }
    expect(summary).toEqual(summarizePlaces(rows));
    expect(summary.right + summary.wrong).toBe(summary.namedPlace);
  });
});
