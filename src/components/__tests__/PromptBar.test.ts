import { describe, expect, it } from 'vitest';

import { modelRejectionNotice } from '../PromptBar';

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
