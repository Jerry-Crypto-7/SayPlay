#!/usr/bin/env node
/**
 * Kontrola před nahráním: neprozrazuje repozitář autora?
 *
 * `RULES.md` §6 vyžaduje slepé hodnocení — hodnotitel nesmí z odevzdaných
 * artefaktů poznat, kdo je autor. Po prvním pushi se to zpětně nespraví:
 * historie je veřejná a přepis zanechá viditelnou stopu. Tenhle skript je
 * proto brána, ne úklid, a běží v `pre-push` hooku (`.githooks/pre-push`).
 *
 * Skončí `0`, když projde všech šest kontrol, jinak `1`.
 *
 * **Skript sám je veřejný, takže v něm nesmí stát skutečné jméno autora.**
 * Zakázané tokeny pro identitu se proto čtou z `blind-check.config.json`,
 * který je v `.gitignore` — a kontrola 1 navíc selže, kdyby se ten soubor
 * někdy ocitl mezi trackovanými.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const CONFIG_FILE = 'blind-check.config.json';

/** Tyhle dva se nekonfigurují — vypnout je by znamenalo vypnout smysl kontroly 3. */
const PUBLIC_TOKENS = ['acmecorp', 'acme'];

/**
 * `--no-replace-objects` na KAŽDÉM volání, jako pre-subcommand flag.
 * `git replace` umí podstrčit jiné bajty pod nezměněné OID (náhrady jsou
 * defaultně zapnuté a jsou lokální ref), takže bez tohohle flagu by šlo
 * projít kontrolou nad obsahem, který se ve skutečnosti nahraje jiný.
 */
function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFail) return typeof error.stdout === 'string' ? error.stdout : '';
    throw error;
  }
}

function loadConfig() {
  const path = join(REPO, CONFIG_FILE);
  if (!existsSync(path)) {
    return { error: `${CONFIG_FILE} chybí — bez něj nejde ověřit skutečné jméno ani cílový účet` };
  }
  // Trackovaný config by znamenal, že jméno, které hledáme, je samo v repu.
  const tracked = git(['ls-files', '--error-unmatch', CONFIG_FILE], { allowFail: true }).trim();
  if (tracked) return { error: `${CONFIG_FILE} je TRACKOVANÝ — nese jména, která se nesmí nahrát` };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      account: typeof parsed.account === 'string' ? parsed.account : '',
      identityTokens: Array.isArray(parsed.identityTokens) ? parsed.identityTokens : [],
    };
  } catch (error) {
    return { error: `${CONFIG_FILE} se nedá přečíst: ${error.message}` };
  }
}

const checks = [];
const check = (id, title, run) => checks.push({ id, title, run });

check(1, 'commit identity carries no author trace', (config) => {
  if (config.error) return config.error;

  const pairs = new Set(
    git(['log', '--format=%an <%ae>|%cn <%ce>', '--all'], { allowFail: true })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (pairs.size === 0) return 'repozitář nemá žádný commit, není co ověřit';
  if (pairs.size > 1) {
    return `historie nese ${pairs.size} různých identit, čekala se právě jedna: ${[...pairs].join(' / ')}`;
  }

  // Autor i committer zvlášť: `--amend` cizím strojem přepíše jen committera.
  const [pair] = pairs;
  const [author, committer] = pair.split('|');
  const tokens = [...PUBLIC_TOKENS, ...config.identityTokens].filter(Boolean);
  const hits = [];
  for (const [role, value] of [['author', author], ['committer', committer]]) {
    for (const token of tokens) {
      if (value.toLowerCase().includes(token.toLowerCase())) hits.push(`${role} obsahuje zakázaný token`);
    }
  }
  return hits.length ? [...new Set(hits)].join('; ') : null;
});

check(2, 'repo-local identity overrides the global one', () => {
  const local = git(['config', '--local', 'user.email'], { allowFail: true }).trim();
  const global = git(['config', '--get', '--global', 'user.email'], { allowFail: true }).trim();
  if (!local) return 'user.email není nastavený lokálně v repu, commity vezmou globální identitu';
  if (global && local === global) return 'lokální user.email je totožný s globálním';
  return null;
});

check(3, 'committed content mentions neither AcmeCorp nor ACME', () => {
  // Nad `HEAD`, ne nad pracovním stromem: nahrávají se commity. Interní podklady
  // (`plans/`, kořenové `*.md`, `.claude/`) jsou v `.gitignore`, takže trackované
  // nejsou a do commitu se nedostanou.
  const args = ['grep', '-Iin'];
  for (const token of PUBLIC_TOKENS) args.push('-e', token);
  args.push('HEAD', '--', '.', ':(exclude)SECURITY-FINDINGS.md');

  const output = git(args, { allowFail: true }).trim();
  if (!output) return null;
  const lines = output.split('\n');
  return `${lines.length} zásahů v commitnutém obsahu, první: ${lines[0].slice(0, 160)}`;
});

check(4, 'SECURITY-FINDINGS.md never entered history', () => {
  // `--full-history`, jinak zjednodušená procházka u merge commitu vedlejší
  // linii odřízne a soubor přidaný na ní zmizí z výsledku.
  const hits = git(['log', '--all', '--full-history', '--format=%H', '--', 'SECURITY-FINDINGS.md'], {
    allowFail: true,
  }).trim();
  if (!hits) return null;
  return `soubor je v ${hits.split('\n').length} commitech, mazání ho z historie neodstraní`;
});

check(5, 'every remote points at the anonymous account', (config) => {
  if (config.error) return config.error;
  if (!config.account) return `${CONFIG_FILE} neuvádí "account", není proti čemu porovnat`;

  const lines = git(['remote', '-v'], { allowFail: true })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'repozitář nemá remote, cíl pushe se ověřit nedá';

  const expected = config.account.toLowerCase();
  const wrong = lines.filter((line) => {
    const url = (line.split(/\s+/)[1] ?? '').toLowerCase();
    return !(url.includes(`github.com/${expected}/`) || url.includes(`github.com:${expected}/`));
  });
  return wrong.length ? `remote nemíří na očekávaný účet: ${wrong[0]}` : null;
});

/**
 * Od T18 nese repozitář poprvé skutečné credentials (`.env.local`) a poprvé
 * syrové odpovědi poskytovatele (`evals/live/`). Obojí brání jen `.gitignore`,
 * a `.gitignore` je jediná editace od toho, aby nebránil nic — `git add -f` ho
 * obejde rovnou. Tahle kontrola je ta druhá vrstva: ptá se, co je doopravdy
 * v `HEAD`, ne co má být ignorované.
 */
check(6, 'no credentials or raw run artefacts entered history', () => {
  // `-z`: bez něj git cesty s ne-ASCII znaky uvozuje (`"evals/live/C\305\276.json"`),
  // a vedoucí uvozovka rozbije obě porovnání níž — soubor s diakritikou by
  // branou prošel.
  const tracked = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { allowFail: true })
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean);
  if (tracked.length === 0) return 'repozitář nemá žádný commit, není co ověřit';

  // Porovnává se na malá písmena: `.ENV.local` je na Windows i macOS funkční
  // soubor s credentials a case-sensitive vzor by ho minul.
  const lower = tracked.map((path) => [path, path.toLowerCase()]);

  // `.env.example` je vzor bez hodnot a commitovat se má; cokoli dalšího ne.
  const envFiles = lower
    .filter(([, path]) => /(^|\/)(\.env($|\.)|\.envrc$)/.test(path) && !path.endsWith('.env.example'))
    .map(([original]) => original);
  if (envFiles.length > 0) return `soubor s credentials je trackovaný: ${envFiles.join(', ')}`;

  const artefacts = lower
    .filter(([, path]) => path.startsWith('evals/live/') && !path.endsWith('.gitkeep'))
    .map(([original]) => original);
  if (artefacts.length > 0)
    return `syrové odpovědi poskytovatele jsou trackované: ${artefacts.slice(0, 3).join(', ')}`;

  // Tvar API klíče v commitnutém obsahu. Hledá se nad `HEAD` ze stejného
  // důvodu jako u kontroly 3: nahrávají se commity, ne pracovní strom.
  const keys = git(['grep', '-InE', 'sk-[A-Za-z0-9_-]{20,}', 'HEAD', '--', '.'], { allowFail: true }).trim();
  if (keys) return `commitnutý obsah nese řetězec ve tvaru API klíče: ${keys.split('\n')[0].slice(0, 160)}`;

  return null;
});

const config = loadConfig();
let failed = 0;

console.log('blind-check — RULES.md §6, kontrola před nahráním\n');
for (const { id, title, run } of checks) {
  let detail;
  try {
    detail = run(config);
  } catch (error) {
    detail = `kontrola spadla: ${error.message}`;
  }
  if (detail) {
    failed += 1;
    console.log(`FAIL  [${id}] ${title}\n        ${detail}`);
  } else {
    console.log(`PASS  [${id}] ${title}`);
  }
}

// Počet se bere z `checks`, ne z konstanty: zapsané číslo se při přidání
// kontroly rozejde se skutečností a hláška pak lže o rozsahu brány.
console.log(
  failed === 0
    ? `\nVšech ${checks.length} kontrol prošlo — push je z hlediska slepého hodnocení v pořádku.`
    : `\n${failed} z ${checks.length} kontrol selhalo. Push se NEPROVEDE.`,
);
process.exit(failed === 0 ? 0 : 1);
