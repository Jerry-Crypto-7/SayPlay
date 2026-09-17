/** Local prompt-size diagnostic only. No transport, model or browser. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildAssetBrief } from '../../../src/model/worldstream-asset-brief';
import { representationCandidates } from '../../../src/assets/resolver';
import { WORLDSTREAM_ASSETS } from '../../../src/assets/catalog';
import type { PlannedObject } from '../../../src/model/worldstream-intent';

it.runIf(process.env.P20_MEASURE_PROMPT === '1')('records request-specific candidate payload sizes without implying model latency', () => {
  const rows = [ ['single aquarium', ['aquarium']], ['five seated people', Array(5).fill('seated person')],
    ['novel shape', ['chronofolding zephyroscope']] ] as const;
  const samples = rows.map(([name, labels]) => {
    const objects: PlannedObject[] = labels.map((label, index) => ({ stableId: `object${index}`, label,
      role: 'hero', importance: 3, synonyms: [] }));
    const before = JSON.stringify(objects.map(object => representationCandidates(object, WORLDSTREAM_ASSETS)));
    const after = JSON.stringify(buildAssetBrief(objects, WORLDSTREAM_ASSETS));
    return { name, objectCount: objects.length, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after),
      savingBytes: Buffer.byteLength(before) - Buffer.byteLength(after) };
  });
  expect(samples[1].afterBytes).toBeLessThan(samples[1].beforeBytes / 2);
  mkdirSync('plans/P20/t16', { recursive: true });
  writeFileSync('plans/P20/t16/prompt-brief.json', JSON.stringify({
    provenance: 'local deterministic prompt payload comparison; no model calls, token counts or latency inference',
    scope: 'candidate JSON payload only; additional dictionary instruction excluded; system grammar unchanged', samples,
  }, null, 2), { flag: 'wx' });
});
