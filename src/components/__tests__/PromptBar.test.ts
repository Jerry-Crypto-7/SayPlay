import { describe, expect, it } from 'vitest';

import { modelRejectionNotice, repairLines } from '../PromptBar';

describe('modelRejectionNotice', () => {
  it('ukáže fázi, důvod i konkrétní detail odmítnutí', () => {
    expect(
      modelRejectionNotice({
        body: {
          outcome: 'REJECTED',
          rejection: {
            stage: 'references',
            reason: 'DANGLING_REFERENCE',
            detail: 'look.modules.moonArch names no declared entity moonArch',
            issues: ['look.modules.moonArch: unknown entity moonArch'],
          },
        },
      }),
    ).toBe(
      'The browser model could not certify a replacement ' +
        '(references/DANGLING_REFERENCE: look.modules.moonArch names no declared entity moonArch); ' +
        'the substitute stays.',
    );
  });

  it('zůstane pravdivá i nad verdiktem bez strukturovaného detailu', () => {
    expect(modelRejectionNotice({ body: { outcome: 'REJECTED', rejection: null } })).toBe(
      'The browser model could not certify a replacement (REJECTED); the substitute stays.',
    );
  });
});

/**
 * Cesta opravy na obrazovku.
 *
 * Bez ní by na plátně stál svět, jehož část dopsal `src/model/repair.ts`, a
 * hláška by ho celý připsala modelu — přesně to tvrzení, které zavřela vlna 0.
 */
describe('repairLines', () => {
  it('vydá text každého zásahu v pořadí, v jakém proběhl', () => {
    expect(
      repairLines({
        outcome: 'CERTIFIED',
        repairs: [
          { kind: 'collideToZone', detail: 'rule touch: onCollide(player, dockPad) names the place dockPad' },
          { kind: 'witnessSolved', detail: 'the system searched 812 replays and found a winning path' },
        ],
      }),
    ).toEqual([
      'rule touch: onCollide(player, dockPad) names the place dockPad',
      'the system searched 812 replays and found a winning path',
    ]);
  });

  it('nevydá nic, když verdikt žádný zásah nenese', () => {
    expect(repairLines({ outcome: 'CERTIFIED' })).toEqual([]);
    expect(repairLines({ outcome: 'CERTIFIED', repairs: [] })).toEqual([]);
  });

  it('zahodí záznam bez čitelného textu místo aby ukázal prázdnou odrážku', () => {
    expect(repairLines({ repairs: [{ kind: 'witnessKept' }, null, 'nonsense', { detail: 'the only real one' }] })).toEqual(
      ['the only real one'],
    );
  });
});
