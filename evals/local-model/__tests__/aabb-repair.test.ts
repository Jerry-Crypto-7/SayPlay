/**
 * Kolik chybí modelu do platné emise — měřeno nad archivem, ne odhadem.
 *
 * První dva běhy vrátily `schemaValid: 0` a daly se přečíst jako „malý model
 * neumí napsat produkční IR". **Není to pravda a tenhle test to drží.** Emise
 * padají skoro všechny na jediném poli, které model nikdy nenapíše:
 * `sim.collisionAabb`. Když se to pole odvodí z toho, co model napsal (sokety
 * plus entity, které na nich stojí), projde schématem většina z nich a část
 * **dojde až k certifikaci** — svět se postaví, odkazy sedí a svědek dojde do
 * výhry. Naměřeno nad během 25. 8. 2026: **15 z 24 platných, 7 dohraných.**
 *
 * ⚠ **Starší čísla „27 z 28" a „12 ze 40" už neplatí** a v repozitáři se dál
 * necitují. Posunulo je schéma a snížení mezi 20. a 25. 8., ne archiv — nad
 * srpnovým archivem dnešní kód vrací 16 z 25 a 8 dohraných. Podrobně
 * v `../decision.md` §8.3.
 *
 * Přesná čísla toho běhu jsou v `../decision.md`. Tady se schválně netvrdí
 * počty: archiv se přeměřením přepíše a test s pevným číslem by pak hlídal
 * historii místo vlastnosti. Drží se **směr**, který o modelu rozhoduje —
 * doplnění jednoho odvozeného pole posune emise z „neplatná" na „certifikovaná".
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { peelEnvelope, worldEmissionSchema } from '../../../src/ir/worlddoc';
import { deriveCollisionAabb } from '../../../src/model/local/aabb';
import { emitLocally } from '../../../src/model/local/emit';
import { RAW_ARCHIVE_PATH, stripThinking } from '../measure-grammar';

interface RawArchiveFile {
  readonly runs: readonly { readonly model: string; readonly outputs: readonly { readonly id: string; readonly raw: string }[] }[];
}

function scriptedEngine(raw: string) {
  return {
    modelId: 'archive',
    complete: () => Promise.resolve({ raw, finishReason: 'stop' }),
    unload: () => Promise.resolve(),
  };
}

function loadArchive(): RawArchiveFile | null {
  try {
    return JSON.parse(readFileSync(RAW_ARCHIVE_PATH, 'utf8')) as RawArchiveFile;
  } catch {
    return null;
  }
}

describe('jedno odvozené pole nad archivem měření', () => {
  const archive = loadArchive();

  it.skipIf(archive === null)('posune emise z neplatných na certifikované', async () => {
    const outputs = archive?.runs[0]?.outputs ?? [];
    expect(outputs.length).toBeGreaterThan(0);

    let validAsIs = 0;
    let validAfterRepair = 0;
    let certified = 0;

    for (const out of outputs) {
      let body: unknown;
      try {
        body = JSON.parse(stripThinking(out.raw));
      } catch {
        continue;
      }
      const peeled = peelEnvelope(body);
      if (peeled === null) continue;
      if (worldEmissionSchema.safeParse(peeled.document).success) {
        validAsIs += 1;
        continue;
      }

      const doc = peeled.document as Record<string, unknown>;
      if (typeof doc.sim !== 'object' || doc.sim === null) continue;
      const repaired = { ...doc, sim: deriveCollisionAabb(doc.sim as Record<string, unknown>) };
      if (!worldEmissionSchema.safeParse(repaired).success) continue;
      validAfterRepair += 1;

      const outcome = await emitLocally({ sentence: out.id, engine: scriptedEngine(JSON.stringify(repaired)) });
      if (outcome.kind === 'verdict' && outcome.body.outcome === 'CERTIFIED') certified += 1;
    }

    // Bez doplnění neprojde schématem nic — to je ten naměřený `schemaValid: 0`.
    expect(validAsIs).toBe(0);
    // A s doplněním projde většina, a část až do certifikace. Kdyby tohle
    // přestalo platit, tvrzení v `decision.md` je neplatné a musí se přepsat.
    expect(validAfterRepair).toBeGreaterThan(outputs.length / 2);
    expect(certified).toBeGreaterThan(0);
  });
});
