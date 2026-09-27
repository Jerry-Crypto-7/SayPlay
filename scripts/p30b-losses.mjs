#!/usr/bin/env node
/**
 * Mapa ztrát P30B (T1): co se ztratí mezi větou a obrazovkou, seřazené podle
 * počtu vět. Dva zdroje nad kódem na HEAD, oba bez sítě a bez modelu:
 *
 * - `draft` – slovní draft, tedy první snímek hry, přes offline řetěz
 *   `scripts/play-fidelity.mjs` (korpus 30 + zamčená `judge-10`);
 * - `ai` – zmrazené AI specy posledního živého běhu (`evals/play/p30b/live.json`)
 *   přes týž řetěz, plus verdikt poroty nad snímkem té hry: položka, kterou
 *   řetěz kreslí a porota ji na snímku nepoznala, je `not-recognized`.
 *
 * Model je zmrazený (P30B), takže AI specy se znovu nevolají – snímek
 * `live.json` vzniká jednou z adresářů živého běhu:
 *   node --experimental-strip-types scripts/p30b-losses.mjs --snapshot <corpus run dir> <judge-10 run dir>
 *   node --experimental-strip-types scripts/p30b-losses.mjs
 * Druhý příkaz zapíše `evals/play/p30b/losses.json` a `losses.md`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { offlineChain } = await import('./play-fidelity.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIDELITY = join(ROOT, 'evals', 'play', 'fidelity');
const OUT = join(ROOT, 'evals', 'play', 'p30b');
const SETS = { corpus: 'corpus.json', judge10: 'judge-10.json' };

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const commit = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

/** Role položky na obrazovce: hrdina, položka (vedlejší role nebo cokoli z věty), prostředí, sloveso. */
export const roleOf = (slot) => (slot === 'hero' ? 'hero' : slot === 'setting' ? 'setting' : slot === 'verb' ? 'verb' : 'item');
export const ROLES = ['hero', 'item', 'setting', 'verb'];

/** Snímek živého běhu: finální (AI) spec a verdikt poroty každé věty, nic víc. */
function snapshot(corpusDir, judgeDir) {
  const take = (dir, set) =>
    readdirSync(dir)
      .filter((name) => /^[a-z]\d+\.json$/.test(name))
      .map((name) => readJson(join(dir, name)))
      .map((result) => ({ id: result.id, set, spec: result.ai.spec, seen: result.judge.ai }));
  const sentences = [...take(corpusDir, 'corpus'), ...take(judgeDir, 'judge10')];
  writeJson(join(OUT, 'live.json'), {
    about: 'P30B: frozen AI specs and the judge verdict on their screenshot, from the last live fidelity runs. The model is frozen for P30B, so every later measurement re-runs the offline chain over these specs at HEAD. See losses.md.',
    runs: { corpus: basename(corpusDir), judge10: basename(judgeDir) },
    sentences,
  });
  console.log(`live -> ${sentences.length} sentences`);
}

/**
 * Položky obou zdrojů nad jednou sadou: řetěz na HEAD a u `ai` navíc verdikt
 * poroty. `why` je první stupeň, na kterém se položka ztratila.
 */
export function measureSet(sentences, live) {
  const byId = new Map(live.map((entry) => [entry.id, entry]));
  const draft = offlineChain(sentences).sentences;
  const withLive = sentences.filter((sentence) => byId.has(sentence.id));
  const ai = offlineChain(withLive, (sentence) => byId.get(sentence.id).spec).sentences;
  const rows = [];
  for (const row of draft) for (const item of row.items) rows.push({ source: 'draft', id: row.id, control: row.control, item: item.item, role: roleOf(item.slot), drawn: item.drawn, why: item.why });
  for (const row of ai) {
    const seen = byId.get(row.id).seen ?? {};
    for (const item of row.items) {
      const recognized = seen[item.item] === true;
      const why = item.why === 'ok' && !recognized ? 'not-recognized' : item.why;
      rows.push({ source: 'ai', id: row.id, control: row.control, item: item.item, role: roleOf(item.slot), drawn: item.drawn, recognized, why });
    }
  }
  return rows;
}

/** Kolik položek role dané role je kreslených (a u `ai` poznaných) – baseline. */
export function tally(rows) {
  const out = {};
  for (const source of ['draft', 'ai']) {
    out[source] = {};
    for (const role of ROLES) {
      const mine = rows.filter((row) => row.source === source && row.role === role);
      out[source][role] = { of: mine.length, drawn: mine.filter((row) => row.drawn).length };
      if (source === 'ai') out[source][role].recognized = mine.filter((row) => row.recognized).length;
    }
  }
  return out;
}

/** Skupiny ztrát `zdroj × why × role × ovládání` seřazené podle počtu postižených vět. */
export function groupLosses(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.why === 'ok') continue;
    const key = `${row.source}|${row.why}|${row.role}|${row.control}`;
    const group = groups.get(key) ?? { key, source: row.source, why: row.why, role: row.role, control: row.control, ids: new Set(), items: [] };
    group.ids.add(row.id);
    group.items.push(`${row.id}:${row.item}`);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sentences: group.ids.size, ids: [...group.ids].sort() }))
    .sort((a, b) => b.sentences - a.sentences || a.key.localeCompare(b.key));
}

/** Kolik skupin nahoře musí mít jmenovanou příčinu a úlohu (AC T1). */
const NAMED = 10;

/**
 * Příčina v kódu a úloha P30B pro skupiny nahoře. Klíč je klíč skupiny;
 * `task` je úloha T2–T6, která ji řeší, nebo `null` a `why` říká, proč ne.
 */
const CAUSES = {
  'ai|not-recognized|setting|tap_go': {
    cause: 'src/play/compile/look.ts:98-102 – mřížka volí rodinu kulis podle slova prostředí z `SETTING_MATERIAL` (look.ts:22-60); Mars, moon, hospital, winter, icy tam nejsou, rodinu tak vybere seed a hrací pole má paletu rodiny (`terraces` = `dunes`, src/geom/families/01-terraces.ts:19) – porota: „Beige ground … do not clearly identify Mars“.',
    task: 'T6',
  },
  'ai|not-in-spec|verb|tap_go': {
    cause: 'src/play/fidelity/chain.ts:158-170 – sloveso je ve specu jen přes ovládání, mechaniku, doplněk nebo pravidlo; režisér zvolil mřížku bez pravidla pro „do taxes“, „date“, „nap“, „pitch“, „walk“.',
    task: null,
    why: 'Výběr ovládání a pravidel dělá režisér (P30A) a knihovna pravidel; P30B režiséra nemění. T2 hlídá opačnou stranu: sloveso, které ve specu je, se musí opravdu stát.',
  },
  'ai|not-recognized|verb|tap_go': {
    cause: 'scripts/play-fidelity.mjs:459 – porota soudí jeden snímek; „collect“, „escape“, „steal“, „hoard“ na stojícím obraze vidět nejdou. Ztráta měření, ne vykreslení.',
    task: 'T2',
    why: 'T2 dokazuje sloveso změnou stavu ve hře místo snímku.',
  },
  'draft|not-in-spec|verb|runner': {
    cause: 'src/play/draft/controls.ts:311 – slovní draft bez známého žánrového slova padne na běžce; abstraktní slovesa („explain“, „do taxes“, „pitch“) ovládání nenese.',
    task: null,
    why: 'Slovní draft a čtečka patří P29B/P30A; první snímek s draftem nahradí AI verze (medián 17 s, `2026-09-26-p29-ground`).',
  },
  'ai|not-in-spec|item|tap_go': {
    cause: 'src/play/draft/draft.ts:252 + src/play/__fixtures__/collect_exit.json – šablona mřížky nese sbíranou „glowing mushroom“ a režisér ji nechá místo „acorn“ / „ice cream“; „alien“ a „investor“ roli nedostanou vůbec.',
    task: null,
    why: 'Roli do specu píše režisér (P30A); bez role ve specu nemá vykreslení co kreslit.',
  },
  'ai|not-recognized|item|shooter': {
    cause: 'src/components/play/arcade/ArcadeStage.tsx:117-119 – `FittedModel` vepíše model do kvádru těla nejmenším poměrem os, takže široký nebo plochý model (balónek, kostlivec s křídly) je drobný; nepřátelé střelnice stojí daleko od kamery („Distant figures“, „Tiny green figures“).',
    task: 'T4',
    why: 'T4 velikost položek, T5 záběr kamery na nepřátele.',
  },
  'ai|not-recognized|verb|throw': {
    cause: 'scripts/play-fidelity.mjs:459 – hod („throw“, „launch“, „flip“) je pohyb, jeden snímek ho neukáže.',
    task: 'T2',
    why: 'T2 dokazuje sloveso změnou stavu (poloha projektilu, zmizelý terč).',
  },
  'draft|not-in-spec|item|runner': {
    cause: 'src/play/draft/controls.ts:311 – draft padne na běžce a role `obstacle` / `coin` dostanou popisky ze slovníku (src/play/draft/draft.ts:948), ne „investor“, „dog“, „acorn“.',
    task: null,
    why: 'Slovník draftu je mimo P30B (čtečka P29B); AI verze z těch čtyř nese jen „dog“ (j04, jako hráče).',
  },
  'draft|not-in-spec|item|throw': {
    cause: 'src/play/capabilities.ts:78 – hod čte popisek jen hráče a terče; projektil je vždy míč („ball/item:ball“ i v AI verzi), takže „snowball“ a „knife“ nemají kam jít.',
    task: null,
    why: 'Chce novou schopnost hodu (projektil z popisku) a spec, který projektil nese (režisér P30A). Kandidát na navazující úlohu, ne T3–T6.',
  },
  'ai|not-recognized|item|tap_go': {
    cause: 'src/play/compile/assets.ts:44-60 – mřížka staví sbírané a věci na 0,6 m a kamera obíhá ve vzdálenosti max(12, 1,4 × rozpětí) (src/play/compile/look.ts:110); baterka i rybář jsou na snímku pár pixelů. Živý běh navíc předcházel povýšení gen3d-fishmonger a gen3d-grandma (fd8cd106).',
    task: 'T4',
    why: 'T4 velikost a model položek mřížky, T5 kamera.',
  },
};

const pct = (hit, of) => (of === 0 ? '–' : `${Math.round((hit / of) * 100)} %`);

function markdown({ header, baseline, groups, rows }) {
  const lines = [
    '# P30B T1 – mapa ztrát mezi větou a obrazovkou',
    '',
    `Naměřeno ${header.measuredAt.slice(0, 10)} na \`${header.commit}\` skriptem \`scripts/p30b-losses.mjs\`. Data: \`losses.json\`.`,
    '',
    '## Zdroje',
    '',
    '- **draft** – slovní draft (první snímek hry) přes offline řetěz `scripts/play-fidelity.mjs` na HEAD; korpus 30 + zamčená `judge-10`.',
    `- **ai** – zmrazené AI specy z posledních živých běhů (\`live.json\`: korpus \`${header.live.corpus}\`, judge-10 \`${header.live.judge10}\`) přes týž řetěz na HEAD, plus verdikt poroty nad snímkem. Položka, kterou řetěz kreslí a porota ji nepoznala, je \`not-recognized\`.`,
    '- `evals/play/fidelity/report.json` má jako `latest` běh `2026-09-23-t6` (hrdina 6/18, položky 18/110) – před P28 a P29, proto se bere novější živý běh téhož formátu, ze kterého pochází i výchozí „hrdina 9/18, položky 45/110“.',
    '- Model se nevolá. `ai` specy jsou zmrazené, takže rozdíl proti baseline jde připsat opravám vykreslení a knihovny.',
    '',
    '## Baseline',
    '',
    '`drawn` = řetěz najde tělo a model z popisku; `poznáno` = porota to na snímku živého běhu viděla (jen `ai`, commit živého běhu, ne HEAD).',
    '',
    '| sada | role | draft drawn | ai drawn | ai poznáno |',
    '|---|---|---|---|---|',
  ];
  for (const [set, tallies] of Object.entries(baseline)) {
    for (const role of ROLES) {
      const draft = tallies.draft[role];
      const ai = tallies.ai[role];
      lines.push(`| ${set} | ${role} | ${draft.drawn}/${draft.of} | ${ai.drawn}/${ai.of} | ${ai.recognized}/${ai.of} (${pct(ai.recognized, ai.of)}) |`);
    }
  }
  lines.push('', `## ${NAMED} největších skupin`, '', 'Seřazeno podle počtu postižených vět (korpus + judge-10).', '');
  lines.push('| # | zdroj | why | role | ovládání | vět | položky | příčina v kódu | úloha |', '|---|---|---|---|---|---|---|---|---|');
  groups.slice(0, NAMED).forEach((group, index) => {
    const named = CAUSES[group.key];
    const task = named.task === null ? `– ${named.why}` : `**${named.task}**${named.why ? ` – ${named.why}` : ''}`;
    lines.push(`| ${index + 1} | ${group.source} | ${group.why} | ${group.role} | ${group.control} | ${group.sentences} | ${group.items.join(', ')} | ${named.cause} | ${task} |`);
  });
  lines.push('', '## Podle role – vstup pro T3–T6', '');
  for (const role of ['hero', 'item', 'setting']) {
    lines.push(`### ${role}`, '');
    for (const group of groups.filter((candidate) => candidate.role === role)) lines.push(`- ${group.sentences} × \`${group.key}\`: ${group.items.join(', ')}`);
    lines.push('');
  }
  const heroLost = rows.filter((row) => row.role === 'hero' && row.source === 'ai' && !row.recognized).length;
  lines.push(
    '## Co z toho plyne',
    '',
    `- **Prostředí mřížky** je největší jednotlivá ztráta: 8 vět, u kterých řetěz tvrdí „nakresleno“ a porota vidí béžové nebo neutrální pole → T6.`,
    `- **Hrdina a položky** se ztrácejí hlavně tím, že jsou malé nebo daleko (${heroLost} hrdinů bez poznání v \`ai\`; porota píše „tiny“, „small“, „distant“) a u mřížky tím, že \`assetSource\` nezná množné číslo ani zástupce arkády („purple elephants“, „squirrel“ → \`no-model\`, src/play/compile/assets.ts:62-65) → T3, T4, T5.`,
    '- **Slovesa** na snímku poznat nejdou; jejich důkaz je změna stavu ve hře → T2.',
    '- Ztráty `not-in-spec` (draft i režisér) jsou mimo P30B: patří čtečce a režisérovi.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function losses() {
  const live = readJson(join(OUT, 'live.json'));
  const rows = [];
  const baseline = {};
  for (const [set, file] of Object.entries(SETS)) {
    const sentences = readJson(join(FIDELITY, file)).sentences;
    const setRows = measureSet(sentences, live.sentences.filter((entry) => entry.set === set)).map((row) => ({ ...row, set }));
    baseline[set] = tally(setRows);
    rows.push(...setRows);
  }
  const named = (key) => (CAUSES[key] === undefined ? {} : { cause: CAUSES[key].cause, task: CAUSES[key].task, reason: CAUSES[key].why });
  const groups = groupLosses(rows).map((group, index) => (index < NAMED ? { ...group, ...named(group.key) } : group));
  const unnamed = groups.slice(0, NAMED).filter((group) => group.cause === undefined);
  if (unnamed.length > 0) throw new Error(`top groups without a named cause: ${unnamed.map((group) => group.key).join(', ')}`);
  const header = { about: 'P30B T1 loss map: sentence-to-screen losses at HEAD over corpus.json (30) and judge-10.json (10). See losses.md.', measuredAt: new Date().toISOString(), commit: commit(), live: live.runs };
  const result = { header, baseline, groups, rows };
  writeJson(join(OUT, 'losses.json'), result);
  writeFileSync(join(OUT, 'losses.md'), markdown(result));
  console.log(JSON.stringify(baseline));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [flag, corpusDir, judgeDir] = process.argv.slice(2);
  if (flag === '--snapshot') snapshot(resolve(corpusDir), resolve(judgeDir));
  else losses();
}
