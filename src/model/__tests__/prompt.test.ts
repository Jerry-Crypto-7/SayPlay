/**
 * Příklad ve zprávě musí projít touž cestou jako emise modelu.
 *
 * Tvar světa nevlastní tenhle soubor ani `prompt.ts` — vlastní ho
 * `src/ir/surface.ts` a `src/ir/build.ts`. Prompt ten tvar jen popisuje, a popis
 * se od kódu rozejde tiše: nic v překladači ani v jiném testu nespojuje větu
 * „rules je objekt klíčovaný ruleId" s tím, co `buildRuntimeWorld` doopravdy
 * čte. Tady se to spojuje — příklad se bere **z hotové systémové zprávy** a jede
 * validací, snížením i verifikací svědka.
 *
 * Proč z textu, a ne z exportované konstanty: konstanta může být bezvadná a do
 * zprávy se přesto nedostat (překlep v markeru, špatné pořadí řádků, `join`
 * nad jiným polem). Ověřuje se to, co uvidí model.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRuntimeWorld } from '../../ir/build';
import { peelEnvelope, validateLook, worldEmissionSchema } from '../../ir/worlddoc';
import { verifyWitness } from '../../verify/witness';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';

/**
 * Slovník je tu doslova ten zmrazený, ale **čtený ze souboru**, ne opsaný —
 * opsaná gramatika by tenhle test nechala zelený i po změně protokolu.
 */
const grammar = (): Grammar => {
  const protocol = JSON.parse(
    readFileSync(new URL('../../../evals/frozen/protocol.v1.json', import.meta.url), 'utf8'),
  ) as {
    grammar: { surfaceEvents: string[]; conditions: string[]; actions: string[] };
    worldDoc: { sim: { fields: string[] }; look: { fields: string[] } };
  };
  return {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
};

/** Příklad stojí ve zprávě poslední, za markerem. Nic za ním být nesmí. */
function exampleFromMessage(): unknown {
  const system = buildEmissionRequest('anything', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  expect(at, 'zpráva neobsahuje marker příkladu').toBeGreaterThan(-1);
  const tail = system.slice(at + EXAMPLE_MARKER.length).trim();
  expect(tail.startsWith('{'), 'za markerem nestojí JSON').toBe(true);
  return JSON.parse(tail);
}

describe('příklad ve zprávě je platná emise', () => {
  it('projde schématem emise', () => {
    const parsed = worldEmissionSchema.safeParse(peelEnvelope(exampleFromMessage())?.document);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `/${i.path.join('/')}: ${i.message}`)).toEqual([]);
  });

  it('sníží se do běhového světa', () => {
    const sim = (exampleFromMessage() as { sim: unknown }).sim;
    const built = buildRuntimeWorld(sim);
    expect(built.ok ? [] : built.issues).toEqual([]);
  });

  it('jeho svědek dojde do výhry', () => {
    const built = buildRuntimeWorld((exampleFromMessage() as { sim: unknown }).sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('CERTIFIED');
  });

  it('má postavitelnou scénu', () => {
    expect(validateLook((exampleFromMessage() as { look: unknown }).look).issues).toEqual([]);
  });
});

describe('zpráva nese slovník i tvar', () => {
  it('jmenuje kontejnery, na kterých snížení stojí', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    // Přesně ta pole, na kterých padly všechny tři emise z prvního živého běhu.
    for (const named of ['sim.layout', 'width, height', 'keyed by stableId', 'keyed by ruleId', 'durationTicks'])
      expect(system, `zpráva mlčí o ${named}`).toContain(named);
  });

  it('nese uživatelský prompt doslova', () => {
    const request = buildEmissionRequest('a tower that falls over', grammar());
    expect(request.user).toContain('a tower that falls over');
  });
});
