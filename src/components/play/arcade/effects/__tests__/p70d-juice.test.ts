/**
 * P70D T4: šťáva z událostí sběrnice a život ve scéně. Zásah hráče (ubraný život) → červený okraj, sebraná věc →
 * „+1“, „méně pohybu“ vypne otřes a ubere částice; každé místo venku má 2–4 druhy života v pozadí.
 */
import { describe, expect, it } from 'vitest';

import { ROLE } from '@/play/arcade/contract';
import { LOOK_IDS, LOOKS } from '@/play/arcade/look';

import type { VisualEvent } from '../bus';
import { POP_CAP, juiceOf, particleCap, shakeAmount } from '../feel';

const event = (kind: VisualEvent['kind'], role: number, body = 1): VisualEvent => ({ kind, body, role, x: 0, y: 0, z: 0, tick: 10 }) as VisualEvent;

/** Obchody a pokoj jsou uvnitř: ptáci ani motýli tam nepatří, stačí prach ve světle. */
const INDOOR = new Set(['mall', 'supermarket', 'living_room']);
/** P70D T5 FPS brána: sníh s prachem −6 až −10 % FPS telefonu, prach na bílém nebyl vidět – venku jen ptáci. */
const FPS_TRIMMED = new Set(['snow']);

describe('juice from bus events (P70D T4)', () => {
  it('lights the red edge only when the player is hit, not an enemy', () => {
    expect(juiceOf([event('hit', ROLE.player)]).hurt).toBe(true);
    expect(juiceOf([event('hit', ROLE.chaser, 4), event('death', ROLE.chaser, 4), event('ability', ROLE.chaser, 4)]).hurt).toBe(false);
    expect(juiceOf([event('pickup', ROLE.collectible, 5)]).hurt).toBe(false);
  });

  it('pops a number over each pickup, at most POP_CAP per batch', () => {
    expect(juiceOf([event('pickup', ROLE.collectible, 5), event('hit', ROLE.player)]).pops.map((pop) => pop.body)).toEqual([5]);
    const many = Array.from({ length: POP_CAP + 3 }, (_, k) => event('pickup', ROLE.collectible, 10 + k));
    expect(juiceOf(many).pops).toHaveLength(POP_CAP);
    expect(juiceOf([event('win', ROLE.player)]).pops).toHaveLength(0);
  });

  it('reduced motion turns the shake off and halves the particles', () => {
    expect(shakeAmount(1, false)).toBeGreaterThan(0);
    expect(shakeAmount(1, true)).toBe(0);
    expect(particleCap(120, false)).toBe(120);
    expect(particleCap(120, true)).toBe(60);
  });

  it('every outdoor place has 2–4 kinds of slow background life', () => {
    for (const id of LOOK_IDS) {
      const kinds = LOOKS[id].ambient;
      expect(new Set(kinds).size, id).toBe(kinds.length);
      if (INDOOR.has(id) || FPS_TRIMMED.has(id)) expect(kinds.length, id).toBeGreaterThanOrEqual(1);
      else {
        expect(kinds.length, id).toBeGreaterThanOrEqual(2);
        expect(kinds.length, id).toBeLessThanOrEqual(4);
      }
    }
  });
});
