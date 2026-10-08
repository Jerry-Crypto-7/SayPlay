import { describe, expect, it } from 'vitest';

import { clayMaterial } from '../ClayMaterial';

/**
 * **Barvu nese geometrie, ne materiál** — a když se to rozbije, obraz to sice
 * ukáže, ale jako „nějak to nevypadá", ne jako pojmenovanou vadu.
 *
 * Naměřeno 28. 8. 2026: `clayMaterial` neměl `vertexColors`, takže se celá
 * scéna vykreslila **jediným odstínem hlíny**. Dvě hodiny se do té doby
 * upravovala paleta, která na to nemohla mít vliv, protože se vůbec nedostala
 * na obrazovku.
 */
describe('paleta se dostane do snímku', () => {
  it('materiál snímku barvu z geometrie vůbec čte', () => {
    const material = clayMaterial({ vertexColors: true });
    expect(material.vertexColors).toBe(true);
    material.dispose();
  });
});
