import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { blindQuestion, catalogBatch, claudeAnswer, CLAUDE_MODEL, matches, verdictOf } from '../judge-sheet.mjs';

const answer = (name: string, alternatives: string[] = [], intact = true, recognizable = true) => ({ name, alternatives, intact, recognizable });

const ROOT = path.resolve(__dirname, '../../..');
const GLB = path.join(ROOT, 'public/assets/worldstream/gen3d/gen3d-acorn-lod0.glb');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Záznam výroby jako z `batch.py`: GLB a vedle něj `meta.json` s rozměry z brány. */
function produced(noun: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p37d-judge-'));
  dirs.push(dir);
  const glb = path.join(dir, `${noun}-lod0.glb`);
  copyFileSync(GLB, glb);
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ gate: { stats: { extentsM: [0.5, 1, 0.5] } } }));
  return { noun, seed: 1, glb, lod1: glb };
}

describe('judge-sheet (P37D T2)', () => {
  it('matches the name inside a longer answer, plural included', () => {
    expect(matches('rope', 'knotted ropes')).toBe(true);
    expect(matches('water gun', 'toy gun')).toBe(true);
    expect(matches('frog', 'toad')).toBe(false);
    expect(matches('conveyor belt', 'leather strap')).toBe(false);
  });

  it('takes the same head only when the other words just describe the look (P47C)', () => {
    // P46I: Codex pustil tyhle přes poslední slovo, vlastník je 15. 10. vyřadil.
    expect(matches('jaguar statue', 'dog statue')).toBe(false);
    expect(matches('taro plant', 'monstera plant')).toBe(false);
    expect(matches('claw machine', 'vending machine')).toBe(false);
    expect(matches('cypress tree', 'pine tree')).toBe(false);
    expect(matches('snowy bench', 'wooden bench')).toBe(true);
    expect(matches('jaguar statue', 'statue')).toBe(true);
    expect(matches('sunken crate', 'old wooden crate')).toBe(true);
  });

  it('accepts a name that is only among the alternatives as top3', () => {
    expect(verdictOf('frog', answer('frog'))).toBe('top1');
    expect(verdictOf('frog', answer('toad', ['frog']))).toBe('top3');
    expect(verdictOf('frog', answer('toad', ['lizard']))).toBe('no');
  });

  it('rejects a recognisable but torn model and an unreadable one', () => {
    // Veverka z prvního kola: soudce ji poznal, ale síť byla potrhaná.
    expect(verdictOf('squirrel', answer('squirrel', [], false))).toBe('broken');
    expect(verdictOf('squirrel', answer('squirrel', [], true, false))).toBe('no');
  });

  it('compares the answer with every name of the record', () => {
    // Pilot: „bug“ soudce nazval „beetle“ – bez synonyma ruční přijetí.
    expect(verdictOf('bug', answer('beetle'))).toBe('no');
    expect(verdictOf(['bug', 'beetle'], answer('beetle'))).toBe('top1');
    expect(verdictOf(['investor', 'businessman'], answer('man in suit', ['businessman']))).toBe('top3');
  });
});

describe('catalogBatch (P37D T4)', () => {
  it('lets the look at the sheet overrule the judge both ways', async () => {
    const models = [produced('frog'), produced('door')];
    const results = { frog: { verdict: 'top1' as const }, door: { verdict: 'no' as const } };
    const viewed = new Map([['frog', 'reject – melted legs'], ['door', 'accept']]);
    const { entries } = await catalogBatch(models, results, viewed);
    expect(entries.map((entry) => [entry.id, entry.checked.verdict])).toEqual([['gen3d-frog', 'fail'], ['gen3d-door', 'pass']]);
    expect(entries[0].checked.judge).toBe('blind four-view sheet: top1; viewed: reject – melted legs');
  });

  it('keeps the judge verdict when nobody looked', async () => {
    const results = { frog: { verdict: 'top3' as const }, door: { verdict: 'broken' as const } };
    const { entries } = await catalogBatch([produced('frog'), produced('door')], results);
    expect(entries.map((entry) => entry.checked.verdict)).toEqual(['pass', 'fail']);
  });

  it('leaves out a model the judge never answered', async () => {
    const results = { frog: { verdict: 'top1' as const }, door: { error: 'codex exit 1: rate limit' } };
    const { entries } = await catalogBatch([produced('frog'), produced('door'), produced('kite')], results, new Map([['door', 'accept']]));
    expect(entries.map((entry) => entry.id)).toEqual(['gen3d-frog']);
  });

  it('puts the synonyms into the nouns after the main name', async () => {
    const { entries } = await catalogBatch([produced('bug')], { bug: { verdict: 'top1' } }, new Map(), { bug: ['beetle'] });
    expect(entries[0].nouns).toEqual(['bug', 'beetle']);
  });
});

describe('blindQuestion (P37D T2)', () => {
  it('asks from an empty directory under a neutral file name', () => {
    // Soudce vidí cestu i pracovní adresář: list „ramp.png“ mu prozradil jméno.
    const named = mkdtempSync(path.join(os.tmpdir(), 'p37d-named-'));
    dirs.push(named);
    mkdirSync(path.join(named, 'sheets'));
    const sheet = path.join(named, 'sheets', 'garden-gnome.png');
    const schema = path.join(named, 'answer-schema.json');
    writeFileSync(sheet, 'png');
    writeFileSync(schema, '{}');
    writeFileSync(path.join(named, 'glb-list.json'), '[{"id":"garden-gnome"}]');

    const { cwd, args } = blindQuestion(sheet, schema);
    dirs.push(cwd);
    expect(readdirSync(cwd).sort()).toEqual(['schema.json', 'sheet.png']);
    expect(path.dirname(cwd)).not.toBe(named);
    expect(args.join(' ')).not.toMatch(/gnome|garden|named/);
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', 'sheet.png']);
  });

  it('asks Opus from an empty directory with the sheet alone and Read as the only tool (P46F)', () => {
    const named = mkdtempSync(path.join(os.tmpdir(), 'p46f-named-'));
    dirs.push(named);
    mkdirSync(path.join(named, 'sheets'));
    const sheet = path.join(named, 'sheets', 'garden-gnome.png');
    const schema = path.join(named, 'answer-schema.json');
    writeFileSync(sheet, 'png');
    writeFileSync(schema, '{"type":"object"}');

    const { cwd, args } = blindQuestion(sheet, schema, 'Which object?', 'claude');
    dirs.push(cwd);
    expect(readdirSync(cwd)).toEqual(['sheet.png']);
    expect(path.dirname(cwd)).not.toBe(named);
    expect(args.join(' ')).not.toMatch(/gnome|garden|named/);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', CLAUDE_MODEL]);
    expect(CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read']);
    expect(args).toContain('--safe-mode');
    expect(args.at(-1)).toMatch(/sheet\.png.*Which object\?$/);
  });
});

describe('claudeAnswer (P46F T2)', () => {
  const said = { name: 'fairy door', alternatives: ['door'], recognizable: true, intact: true };
  const envelope = (fields: Record<string, unknown>) => JSON.stringify({ type: 'result', is_error: false, ...fields });

  it('takes the structured output of claude -p', () => {
    expect(claudeAnswer(0, envelope({ result: '', structured_output: said })).answer).toEqual(said);
  });

  it('finds the answer JSON inside text around it', () => {
    const chatty = `Looking at the sheet: ${JSON.stringify(said)} – a small arched door {not json}.`;
    expect(claudeAnswer(0, envelope({ result: chatty })).answer).toEqual(said);
    expect(claudeAnswer(0, `Sure! ${JSON.stringify(said)}`).answer).toEqual(said);
  });

  it('gives no answer when the process failed, so the precheck reads unavailable', () => {
    const limit = claudeAnswer(1, envelope({ is_error: true, result: "You've hit your limit · resets 3am" }));
    expect(limit.answer).toBeUndefined();
    expect(limit.error).toContain('resets 3am');
    expect(claudeAnswer(0, envelope({ is_error: true, result: 'API Error: 529' })).answer).toBeUndefined();
    expect(claudeAnswer(null, '').answer).toBeUndefined();
  });

  it('refuses JSON that is not the schema answer', () => {
    expect(claudeAnswer(0, envelope({ result: '{"name":"door"}' })).answer).toBeUndefined();
  });
});
