/**
 * Zelený strom pro testy `submission-check.mjs` a nástroje kolem něj.
 *
 * Není to `.test.ts`, takže to vitest nespouští jako testy — je to fixtura,
 * kterou sdílí `submission-check.test.ts` (čisté funkce) a
 * `submission-check-gate.test.ts` (chování brány nad stromem).
 *
 * **Strom se staví jednou a každý test dostane jeho kopii.** Postavit ho znamená
 * dvakrát spustit `license-gate --sync` a inicializovat git; třicetkrát po sobě
 * by to byla většina času celé sady.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SCRIPT = join(process.cwd(), 'scripts', 'submission-check.mjs');
export const LICENSE_GATE = join(process.cwd(), 'scripts', 'license-gate.mjs');

export const REPO_URL = 'https://github.com/anonymous-builder/worldsmith';
export const DEMO_URL = 'https://worldsmith.example.io/';
export const BACKEND_URL = 'https://worldsmith.example.io/api/health';
export const GUARANTEE =
  'Každý potvrzený graf nese konečnou vstupní stopu, kterou runtime přehrál až do `win()`.';

/** Pevný okamžik, proti kterému se měří stáří záznamu hlídače. */
export const NOW = Date.parse('2026-11-10T12:00:00Z');

const created: string[] = [];

/**
 * Zápis se čte zpátky. Případ, který strom rozbije a rovnou tomu uvěří, hlásí
 * při ztraceném zápisu „brána nezachytila vadu" — tedy pravý opak toho, co se
 * stalo. Falešná zelená se takhle změní v hlášku, která ukáže na svoji příčinu.
 */
function writeChecked(target: string, body: string | Buffer): void {
  writeFileSync(target, body as never);
  const want = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  if (!readFileSync(target).equals(want)) throw new Error(`zápis do ${target} se neprojevil na disku`);
}

export function write(dir: string, name: string, body: string | Buffer): void {
  const target = join(dir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeChecked(target, body);
}

export function readRegistry(dir: string): { entries: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(dir, 'disclosure.json'), 'utf8')) as { entries: Record<string, unknown>[] };
}

export function writeRegistry(dir: string, registry: { entries: Record<string, unknown>[] }): void {
  writeChecked(join(dir, 'disclosure.json'), `${JSON.stringify(registry, null, 2)}\n`);
}

export function patchManifest(dir: string, patch: Record<string, unknown>): void {
  const path = join(dir, 'docs/submission/submission.json');
  const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeChecked(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

export function patchMonitoring(dir: string, patch: Record<string, unknown>): void {
  const path = join(dir, 'ops/monitoring/uptime.json');
  const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeChecked(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

/**
 * `git add -A` se ověřuje stejně jako zápis: kontrola 6 čte obsah z indexu, ne
 * z disku, takže rozbití, které do indexu nedojde, je pro bránu neviditelné.
 */
export function stage(dir: string): void {
  execFileSync('git', ['--no-replace-objects', 'add', '-A'], { cwd: dir, stdio: 'ignore' });
  // `git diff` tady nestačí: nový soubor je netrackovaný, takže o něm mlčí –
  // a právě nové soubory sem většina případů kontroly 6 zapisuje. Druhý sloupec
  // porcelánu je stav pracovního stromu; prázdný znamená „všechno je v indexu".
  const left = execFileSync('git', ['--no-replace-objects', 'status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 1 && line[1] !== ' ');
  if (left.length > 0) throw new Error(`git add -A nepobral: ${left.join(' | ')}`);
}

/**
 * `license-gate --sync` nad rozestavěným stromem. **Návratový kód se ignoruje
 * schválně:** `main()` po syncu ještě pouští kontroly a mezi prvním a druhým
 * voláním registru chybí ruční položky, takže první běh nutně končí jedničkou.
 * Kdyby se tu házelo, fixtura by se nedala postavit po částech.
 */
function syncGate(dir: string): void {
  spawnSync(process.execPath, [LICENSE_GATE, '--sync'], { cwd: dir, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------

export function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** Nejmenší MP4, ve kterém je čitelný `mvhd` — jen kvůli délce, nic se nepřehrává. */
export function mp4(seconds: number, version: 0 | 1 = 0): Buffer {
  const timescale = 600;
  const body = Buffer.alloc(version === 1 ? 112 : 100);
  body.writeUInt8(version, 0);
  if (version === 1) {
    body.writeUInt32BE(timescale, 20);
    body.writeBigUInt64BE(BigInt(Math.round(seconds * timescale)), 24);
  } else {
    body.writeUInt32BE(timescale, 12);
    body.writeUInt32BE(Math.round(seconds * timescale), 16);
  }
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('mvhd', body))]);
}

// ---------------------------------------------------------------------------
// Obsah zeleného stromu
// ---------------------------------------------------------------------------

export function description(): string {
  // Synthetic copy meets the current source disclosure contract and cites a
  // fixture report. None of these sentences establish a real evaluation result.
  const filler = 'Systém bere větu v přirozeném jazyce a vrací hratelný svět, jehož pravidla jsou čitelná. '.repeat(20);
  return [
    '# Worldsmith',
    '',
    '**Focus kategorie:** Games',
    '',
    filler,
    '',
    'A short source becomes a discrete spatial scenario with one timer intervention. Geometry is schematic.',
    'The user reviews seven critical parameter groups before acceptance; missing or conflicting support blocks acceptance.',
    'This acknowledgement does not certify semantic correctness. A structurally valid citation is not a semantic guarantee.',
    'CLI timings include process and transport overhead.',
    'Five-person usability evidence and independent semantic review remain separate requirements.',
    '',
    'Naměřeno na zmrazeném korpusu: 2/27 kandidátů prošlo bez opravy.',
    '',
  ].join('\n');
}

export function heartbeat(at = new Date(NOW - 60_000).toISOString()): string {
  return `${JSON.stringify({
    at,
    targets: [
      { url: REPO_URL, ok: true },
      { url: DEMO_URL, ok: true },
      { url: BACKEND_URL, ok: true },
    ],
  })}\n`;
}

function manifest(): string {
  return `${JSON.stringify(
    {
      repositoryUrl: REPO_URL,
      demoUrl: DEMO_URL,
      backendUrl: BACKEND_URL,
      videoPath: 'video/final.mp4',
      descriptionPath: 'docs/submission/description.md',
      modelTablePath: 'src/model/prompt.ts',
      monitoringPath: 'ops/monitoring/uptime.json',
      dataDirs: ['data'],
      measurementReports: ['evals/gates/report.md'],
    },
    null,
    2,
  )}\n`;
}

function monitoring(): string {
  return `${JSON.stringify(
    {
      targets: [
        { name: 'repository', url: REPO_URL },
        { name: 'demo', url: DEMO_URL },
        { name: 'backend', url: BACKEND_URL },
      ],
      intervalSeconds: 300,
      coverageUntil: '2026-12-01',
      alert: { channel: 'email', destination: 'ops@example.invalid' },
      heartbeatPath: 'ops/monitoring/heartbeat.jsonl',
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Síť
// ---------------------------------------------------------------------------

export type Wire = Record<string, { status: number; contentType: string } | 'throw'>;

export const GREEN_WIRE: Wire = {
  [REPO_URL]: { status: 200, contentType: 'text/html; charset=utf-8' },
  [DEMO_URL]: { status: 200, contentType: 'text/html; charset=utf-8' },
  [BACKEND_URL]: { status: 200, contentType: 'application/json' },
};

/**
 * Podvržená síť. **Bere se jako parametr kontextu, ne z prostředí** — proměnná,
 * kterou by šlo síť zfalšovat, by byla cesta, jak bránu obejít i v ostrém běhu.
 */
export function fakeFetch(wire: Wire): typeof fetch {
  return (async (input: string) => {
    const answer = wire[String(input)];
    if (!answer || answer === 'throw') throw new Error(`ECONNREFUSED ${String(input)}`);
    return {
      status: answer.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? answer.contentType : null) },
      text: async () => '<!doctype html><title>worldsmith</title>',
    };
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Stavba stromu
// ---------------------------------------------------------------------------

export function buildTemplate(): string {
  const dir = mkdtempSync(join(tmpdir(), 'submission-tpl-'));
  created.push(dir);

  write(
    dir,
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '0.0.0' },
        'node_modules/left-pad': {
          version: '1.0.0',
          license: 'MIT',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
        },
      },
    }),
  );
  write(dir, 'node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', author: 'Pad Author <a@b.io>' }));
  write(dir, 'node_modules/left-pad/LICENSE', 'MIT License\n\nCopyright (c) 2016 Pad Author\n');
  write(dir, 'src/client.ts', "export const url = 'https://api.fixture-provider.io/v1';\n");
  write(dir, 'src/model/prompt.ts', "export const EMISSION_MODEL = 'claude-opus-5';\n");

  syncGate(dir);

  const registry = readRegistry(dir);
  registry.entries.push(
    {
      name: 'example provider',
      kind: 'api',
      source: 'https://api.fixture-provider.io',
      authorOrProvider: 'Example Provider Inc.',
      license: 'komerční ToS',
      requiredNotices: ['žádné pro volajícího'],
      attribution: 'Example Provider Inc.',
      reviewNote: 'podmínky přečteny',
    },
    {
      name: 'claude-opus-5',
      kind: 'model',
      source: 'https://docs.example.invalid/models',
      authorOrProvider: 'Example AI',
      license: 'podmínky služby',
      requiredNotices: ['žádné pro volajícího'],
      attribution: 'Example AI',
      reviewNote: 'model emisní cesty',
    },
    {
      name: 'zmrazený korpus',
      kind: 'dataset',
      source: 'vlastní tvorba',
      authorOrProvider: 'worldsmith',
      license: 'MIT',
      requiredNotices: ['copyright notice'],
      attribution: 'worldsmith',
      reviewNote: 'vlastní data',
      paths: ['data'],
    },
  );
  writeRegistry(dir, registry);
  syncGate(dir);

  write(dir, 'data/corpus.jsonl', '{"prompt":"a"}\n');
  write(dir, 'DESIGN-BOOK.md', `# Design book\n\n## 5. Gramatika\n\nNěco.\n\n## 6. Garance\n\n> **${GUARANTEE}**\n\nDál.\n`);
  write(dir, 'plans/P8-odevzdani.md', '# P8\n\n<!-- registrace: focus-kategorie = Games -->\n\n- [ ] něco\n');
  write(dir, 'docs/submission/description.md', description());
  write(dir, 'docs/submission/submission.json', manifest());
  write(dir, 'evals/gates/report.md', 'rawPatchPassRate 2/27 = 7,4 %\n');
  write(dir, 'video/final.mp4', mp4(95));
  write(dir, 'ops/monitoring/uptime.json', monitoring());
  write(dir, 'ops/monitoring/heartbeat.jsonl', heartbeat());
  write(dir, '.gitignore', 'node_modules/\nblind-check.config.json\n');

  // Git je potřeba dvakrát: `git ls-files` je zdroj sledovaných cest a
  // blind-check bez commitu nemá co číst.
  execFileSync('git', ['--no-replace-objects', 'init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['--no-replace-objects', 'config', 'user.name', 'worldsmith'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['--no-replace-objects', 'config', 'user.email', 'worldsmith@fixture.invalid'], { cwd: dir, stdio: 'ignore' });
  stage(dir);
  execFileSync('git', ['--no-replace-objects', 'commit', '-m', 'fixture'], { cwd: dir, stdio: 'ignore' });

  // Netrackovaný schválně: nese jména, která se nesmí nahrát. Kontrola 1
  // blind-checku selže, kdyby se ocitl v indexu.
  write(
    dir,
    'blind-check.config.json',
    // `publicTokens` je povinné: bez něj je config neplatný a blind-check
    // selže na configu, ne na tom, co má fixtura zkoumat.
    JSON.stringify({
      account: 'anonymous-builder',
      publicTokens: ['acmecorp', 'acme'],
      identityTokens: ['realname'],
    }),
  );
  return dir;
}

export function freshRepo(template: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'submission-'));
  created.push(dir);
  rmSync(dir, { recursive: true, force: true });
  cpSync(template, dir, { recursive: true });
  return dir;
}

export function cleanup(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
}
