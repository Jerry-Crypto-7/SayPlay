/**
 * A6: kolik bajtů kontraktu doopravdy jde nahoru, po fázích.
 *
 * **Offline a deterministické.** Prompty staví ty samé funkce, které volá
 * produkt, nad zmrazenou gramatikou a produkčním příkladem plánu. Žádné
 * volání modelu, žádná latence, žádná tokenizace — bajty UTF-8 jsou to
 * jediné, co tenhle experiment tvrdí. Tokeny se odsud **neodhadují**:
 * `optimization-baseline.md` chce skutečnou provider usage, a ta bez živého
 * běhu neexistuje.
 *
 * Důvod, proč to vzniklo: A6 chce „bajty/tokeny vstupu a výstupu" a A7 chce
 * „odstranit duplicitní schema/grammar text". Do 11. 9. 2026 měřil jediný
 * offline experiment (`contract-size.measure.ts`) jen mechanické bindingId
 * a sám o sobě říká, že to není porovnání celého promptu. Tohle je ten
 * chybějící celek.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildEmissionRequest, type Grammar, type UpstreamRequest } from '../../src/model/prompt';
import { buildIntentRequest } from '../../src/model/worldstream-intent';
import { buildCompilerRequest, WORLD_CONTRACT_MARKER, WORLD_CONTRACT_END } from '../../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../../src/model/worldstream-examples';
import { frozenGrammar } from '../../src/model/client';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Zmrazená gramatika, kterou používá server. Selhání je vada fixture, ne měření. */
function grammar(): Grammar {
  const read = frozenGrammar();
  if (!read.ok) throw new Error(`frozen grammar unavailable: ${read.reason}`);
  return read.value;
}

function shape(stage: string, request: UpstreamRequest) {
  return { stage, model: request.model, systemBytes: bytes(request.system), userBytes: bytes(request.user),
    totalBytes: bytes(request.system) + bytes(request.user) };
}

it('records the real per-stage contract size and the nested world contract', () => {
  const g = grammar();
  // Prázdná věta u emission: měří se kontrakt, ne zadání. Text věty je proti
  // němu šum a u každé věty jiný.
  const emission = buildEmissionRequest('', g);
  const planner = buildIntentRequest('');
  const compiler = buildCompilerRequest(EXAMPLE_PLAN, g);

  // Compiler vkládá celý emission kontrakt doslova mezi dvě značky. Tohle je
  // ta duplicita, na kterou míří A7 — měřená, ne odhadnutá.
  const start = compiler.system.indexOf(WORLD_CONTRACT_MARKER);
  const end = compiler.system.indexOf(WORLD_CONTRACT_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const nested = compiler.system.slice(start + WORLD_CONTRACT_MARKER.length, end);
  const nestedBytes = bytes(nested);

  // Vložený blok MUSÍ být emission kontrakt, ne jen nějaký text mezi značkami.
  expect(nested).toContain(emission.system.trim().slice(0, 120));

  const stages = [shape('planner', planner), shape('emission', emission), shape('compiler', compiler)];

  // Doslova zdvojený řádek uvnitř JEDNOHO promptu je jediný kandidát na
  // zkrácení, který nemění, co model smí — proto se počítá zvlášť od vloženého
  // kontraktu výš. Krátké a strukturální řádky se nepočítají: prázdné řádky,
  // uzávěry JSON ukázek (`},`, `]`) a odrážky se v příkladu opakují právem.
  const repeatedLines = (text: string) => {
    const seen = new Map<string, number>();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.length < 24) continue;
      seen.set(line, (seen.get(line) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, count]) => count > 1)
      .map(([line, count]) => ({ count, bytes: bytes(line) * (count - 1), line }))
      .sort((a, b) => b.bytes - a.bytes);
  };
  const compilerRepeats = repeatedLines(compiler.system);
  const firstSentenceBytes = stages.find((s) => s.stage === 'planner')!.totalBytes
    + stages.find((s) => s.stage === 'compiler')!.totalBytes;

  const result = {
    kind: 'offline-prompt-size', measuredAt: new Date().toISOString(),
    note: 'UTF-8 bytes of the prompts the product itself builds. No model call, no tokens, no latency.',
    modelCalls: 0, modelLatencyMs: null, tokens: 'NOT_RUN', usdCost: null,
    stages,
    /** Jedna první věta = planner + compiler. Emission je vložený uvnitř compileru. */
    firstSentence: { calls: 2, promptBytes: firstSentenceBytes },
    nestedWorldContract: {
      bytes: nestedBytes,
      shareOfCompilerSystem: Number((nestedBytes / bytes(compiler.system)).toFixed(4)),
      note: 'buildCompilerRequest embeds buildEmissionRequest().system verbatim between the two markers.',
    },
    /** Zdvojené řádky v compiler promptu: bezpečný kandidát, protože nic neubírá. */
    compilerRepeatedLines: {
      count: compilerRepeats.length,
      recoverableBytes: compilerRepeats.reduce((sum, entry) => sum + entry.bytes, 0),
      worst: compilerRepeats.slice(0, 8),
    },
  };

  mkdirSync('scratch', { recursive: true });
  writeFileSync('scratch/prompt-size.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  // Pojistka, ne cíl: kontrakt nesmí tiše zmizet ani vybuchnout na desetinásobek.
  for (const stage of stages) expect(stage.systemBytes).toBeGreaterThan(200);
  expect(nestedBytes).toBeGreaterThan(200);
});
