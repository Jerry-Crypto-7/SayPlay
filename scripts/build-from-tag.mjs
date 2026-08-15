#!/usr/bin/env node
/**
 * Hermetický build fallbacku z tagu `fallback-v1` (P2 T205a).
 *
 * ## Co se dokazuje
 *
 * **Artefakt vznikl ze stromu tagu a z ničeho jiného.** Ne „obsahuje očekávanou
 * hodnotu", ne „prošel build a zvlášť prošel smoke" — ty dvě věty dohromady
 * nedokazují nic, protože mezi nimi není vazba.
 *
 * Řetězec review nad T205 zavřel čtyři díry a tvar téhle sekvence je jejich
 * přímý důsledek:
 *
 *  - **kolo 2** — `GET /api/build-id` je sebeprohlášení artefaktu. Hodnota proto
 *    vzniká ze **skutečných bajtů čerstvého checkoutu** (`git write-tree` nad
 *    rozbaleným archivem), ne opsáním `git rev-parse fallback-v1^{tree}`.
 *  - **kolo 3** — `HEAD^{tree}` je hash commitu, ne pracovního stromu, takže
 *    necommitnutá změna serverového kódu projde všemi kontrolami a statické
 *    assety ji neodrazí. Řešení není další kontrola, ale **odstranění vstupu**:
 *    build běží z `git archive` v prázdném adresáři, takže se pracovní strom
 *    nemá jak do artefaktu dostat. `git status --porcelain` zůstává jako hlasitý
 *    alarm, ne jako obrana.
 *  - **kolo 4** — strom tagu artefakt neurčuje sám, určuje ho **strom plus
 *    prostředí**: `prebuild` skript uvnitř tagu umí z nelistované proměnné
 *    vygenerovat server-only modul. Proto je prostředí zamčené allowlistem
 *    `ops/build-env.allow`, který leží **uvnitř tagu**, proto build svou
 *    viditelnou množinu proměnných hlásí sám (`next.config.mjs`), a proto druhý
 *    build běží v **jinak nastaveném okolním prostředí**.
 *  - **`CLAUDE.md` rozpor 5** — `git replace` umí pod nezměněným OID vrátit jiné
 *    bajty. Každé volání gitu proto nese `--no-replace-objects` jako
 *    pre-subcommand flag, i v pomocníkovi, ne jen u `show`.
 *
 * ## Kde tenhle řetězec vědomě končí
 *
 * `node_modules` se instaluje z `package-lock.json` **uvnitř tagu**, offline, z
 * lokální npm cache. Kompromitovaný runner, podvržený `git` a nedeterministický
 * toolchain obrana nejsou a plán to říká nahlas: účel je zabránit tomu, aby si
 * autor omylem odškrtl fallback, který nikdy neběžel — ne odolat autorovi, který
 * se rozhodl podvádět sám sebe.
 *
 * Druhá přiznaná mez: **bit spustitelnosti se bere z tagu, ne z disku.** NTFS ho
 * nemá, takže z rozbaleného archivu ho přečíst nejde. Porovnání stromů tedy
 * dokazuje shodu **obsahu** všech souborů, ne jejich módů.
 *
 * Spuštění: `npm run build:from-tag`
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FALLBACK_ROUTE, isLocalConnect, scrubbedEnv } from './prove-fallback-isolation.mjs';

export const TAG = 'fallback-v1';

/** Allowlist prostředí. Cesta je relativní k **rozbalenému archivu**, ne k repu. */
export const ALLOWLIST_FILE = 'ops/build-env.allow';

export const LOCK_FILE = 'ops/fallback-v1-lock.json';

/**
 * Co z `.next/` se považuje za artefakt.
 *
 * `cache/` je mezivýsledek webpacku a `trace` je časová osa buildu — obojí se
 * mezi dvěma běhy legitimně liší a hashovat je by z reprodukovatelnosti udělalo
 * test hodin. Všechno ostatní pod `.next/` do porovnání patří: zúžit ho na
 * `static/` by nechalo serverovou půlku bez kontroly, což je přesně ta polovina,
 * kterou kolo 3 označilo za slepé místo.
 */
export const ARTIFACT_SKIP = ['cache', 'trace', 'trace-build'];

/**
 * Pole, která `next build` vygeneruje náhodně při každém běhu, a proto se z
 * porovnání dvou artefaktů vyjímají.
 *
 * **Naměřeno, ne odhadnuto:** dva buildy z téhož stromu se lišily v pěti
 * souborech. Tři z nich byly pořadí klíčů v manifestech skládaných paralelními
 * workery (to řeší kanonizace níž), dva tyhle čtyři hodnoty. Jsou to
 * **vygenerované klíče**, ne vstupy buildu: Next je vyrábí pro draft mode a pro
 * šifrování uzávěrů Server Actions, aplikace ani jedno nepoužívá.
 *
 * **Proč se nepinují, i když by šly** (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` a
 * spol.): odvodit je z hashe stromu znamená napsat podpisový klíč do veřejného
 * repozitáře, protože tag i strom se publikují. Reprodukovatelnost by se koupila
 * za veřejný klíč — špatná směna, i když ho dnešní aplikace nečte.
 *
 * Výjimka je **jmenná a listová**, ne zástupný znak: zbytek obou souborů se
 * porovnává dál. Kdyby to byl vzor, dala by se pod něj schovat změna chování.
 */
export const GENERATED_SECRETS = {
  'prerender-manifest.json': [
    'preview.previewModeId',
    'preview.previewModeSigningKey',
    'preview.previewModeEncryptionKey',
  ],
  'server/server-reference-manifest.json': ['encryptionKey'],
};

/**
 * Proměnné, které druhý build dostane do **okolního** prostředí a nesmí je
 * uvidět. `BUILD_VARIANT` je doslova ta z kola 4 review; zbytek jsou tvary,
 * kterými se konfigurace obvykle propašuje do artefaktu.
 *
 * Žádné z těch jmen nesmí být v sekci `[platform]` allowlistu — jinak by
 * kontrola procházela proto, že jsme si ji povolili.
 */
export const POLLUTION = {
  BUILD_VARIANT: 'tampered',
  WORLDSMITH_FEATURE_FLAGS: 'all',
  NEXT_PUBLIC_INJECTED: 'yes',
  npm_lifecycle_event: 'prebuild',
};

// ---------------------------------------------------------------------------
// Čisté pomocné funkce (testované v scripts/__tests__/build-from-tag.test.ts)
// ---------------------------------------------------------------------------

/**
 * Allowlist ze souboru, rozdělený na dvě sekce.
 *
 * `host` je to, co pipeline vědomě předává — tam je minimalita smysl věci.
 * `platform` je to, co přidá OS nebo toolchain a odebrat to nejde; naměřená mez,
 * ne zadní vrátka (odůvodnění je v hlavičce `ops/build-env.allow`).
 *
 * Jména jdou velkými písmeny: na Windows jsou case-insensitive, takže `Path` a
 * `PATH` je táž proměnná a porovnávat je case-sensitive by allowlist tiše obešlo.
 */
export function parseAllowlist(text) {
  const sections = { host: [], platform: [] };
  let current = 'host';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const section = /^\[(\w+)\]$/.exec(line);
    if (section !== null) {
      if (!(section[1].toLowerCase() in sections)) {
        throw new Error(`allowlist má neznámou sekci [${section[1]}]`);
      }
      current = section[1].toLowerCase();
      continue;
    }
    sections[current].push(line.toUpperCase());
  }
  const host = [...new Set(sections.host)];
  const platform = [...new Set(sections.platform)].filter((name) => !host.includes(name));
  return { host, platform, all: [...host, ...platform] };
}

/** Prostředí pro podproces: jen to, co allowlist jmenuje a co zdroj má. */
export function envFrom(allow, source) {
  const allowed = new Set(allow);
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/**
 * Proměnné, které build **viděl** a allowlist je nejmenuje.
 *
 * Tohle je vlastní kontrola kroku 2b a je schválně nad **pozorovanou** množinou,
 * ne nad tou, kterou pipeline poslala. Kdyby se porovnávalo to, co jsme sami
 * složili, kontrola by tvrdila „filtr filtruje" — což je pravda, která o
 * prostředí buildu neříká nic. Runtime, shell nebo Windows si můžou přidat
 * vlastní, a právě to má vypadnout.
 */
export function unexpectedEnvKeys(allow, observed) {
  const allowed = new Set(allow);
  return observed
    .map((key) => key.trim())
    .filter((key) => key !== '' && !allowed.has(key.toUpperCase()))
    .sort();
}

/** Řádky `git ls-tree -r <tag>` → cesty se spustitelným bitem. */
export function executablePaths(lsTree) {
  return lsTree
    .split('\n')
    .filter((line) => line.startsWith('100755 '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .filter((path) => path !== '');
}

/** Všechny soubory pod `dir`, relativně, s lomítky dopředu, seřazené. */
export function walkFiles(root, dir = '', skip = []) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (dir === '' && skip.includes(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel, skip));
    else out.push(rel);
  }
  return out.sort();
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Rekurzivní serializace se seřazenými klíči. Pořadí klíčů není obsah. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

/**
 * Bajty souboru artefaktu tak, jak se porovnávají.
 *
 * JSON manifesty se kanonizují, protože `next build` je skládá z výsledků
 * paralelních workerů a pořadí klíčů se mezi běhy liší, aniž by se lišil obsah.
 * Ostatní soubory jdou bit po bitu — u chunku by kanonizace nic neznamenala a
 * zamlčela by skutečný rozdíl.
 */
export function normalizedBytes(relPath, bytes) {
  if (!relPath.endsWith('.json')) return bytes;
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf-8'));
  } catch {
    // Nevalidní JSON se neopravuje, porovná se jak leží. Tichá tolerance by tu
    // byla horší než hlasitý rozdíl.
    return bytes;
  }
  for (const path of GENERATED_SECRETS[relPath] ?? []) {
    const segments = path.split('.');
    const leaf = segments.pop();
    let node = parsed;
    for (const segment of segments) {
      node = node === null || typeof node !== 'object' ? null : node[segment];
    }
    if (node !== null && typeof node === 'object') delete node[leaf];
  }
  return canonicalJson(parsed);
}

/** Cesta → `sha256` porovnávaného obsahu, pro celý strom souborů. */
export function hashFiles(root, files) {
  const out = {};
  for (const file of files) out[file] = sha256(normalizedBytes(file, readFileSync(join(root, file))));
  return out;
}

/**
 * Rozdíly mezi dvěma otisky. Vrací **všechny** tři třídy zvlášť, protože
 * „chybí soubor" a „liší se obsah" jsou různé vady a slévat je do počtu by
 * zprávu udělalo nečitelnou přesně v okamžiku, kdy je potřeba.
 */
export function diffHashes(first, second) {
  const onlyFirst = Object.keys(first).filter((file) => !(file in second)).sort();
  const onlySecond = Object.keys(second).filter((file) => !(file in first)).sort();
  const changed = Object.keys(first)
    .filter((file) => file in second && first[file] !== second[file])
    .sort();
  return { onlyFirst, onlySecond, changed };
}

// ---------------------------------------------------------------------------
// Sekvence
// ---------------------------------------------------------------------------

const ROOT = resolve(process.cwd());

function git(args, options = {}) {
  // `--no-replace-objects` jako pre-subcommand flag na KAŽDÉM volání, i tady v
  // pomocníkovi. Náhrada nad tree nebo nad objektem tagu obejde ancestry i čtení
  // anotace, takže flag jen u `show` je díra (`CLAUDE.md` rozpor 5, pátá revize).
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    ...(options.env === undefined ? {} : { env: options.env }),
  }).trim();
}

function step(index, label) {
  process.stdout.write(`\n[${index}/8] ${label}\n`);
}

function say(text) {
  process.stdout.write(`      ${text}\n`);
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function run(label, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${label} skončil kódem ${code}`))));
  });
}

/**
 * Kandidáti na `tar`, v pořadí, ve kterém se zkoušejí.
 *
 * **Holé `tar` z `PATH` nestačí a je to naměřené.** Na tomhle stroji se první
 * rozřeší `tar.exe` z Git for Windows a spuštění skončí `EPERM` — Windows ho
 * nepustí — zatímco `System32\tar.exe` (bsdtar, součást Windows od 1803) běží
 * bez problému. Pořadí v `PATH` tedy rozhoduje o tom, jestli pipeline vůbec
 * začne, a to je závislost, kterou nemá cenu nechat na náhodě.
 */
function tarCandidates() {
  const system32 = process.env.SYSTEMROOT ?? process.env.WINDIR;
  return process.platform === 'win32' && system32 !== undefined
    ? [join(system32, 'System32', 'tar.exe'), 'tar']
    : ['tar'];
}

/** Rozbalí archiv tagu do adresáře. */
function extractArchive(tarball, into) {
  mkdirSync(into, { recursive: true });
  const failures = [];
  for (const candidate of tarCandidates()) {
    try {
      execFileSync(candidate, ['-xf', tarball, '-C', into], { stdio: 'inherit' });
      return;
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`archiv se nepodařilo rozbalit:\n  ${failures.join('\n  ')}`);
}

/**
 * Hash stromu **z bajtů na disku**, ne z tagu.
 *
 * Dočasné repo se zakládá uvnitř rozbaleného adresáře, takže `git add -A`
 * indexuje přesně to, co tam leží. Módy 100755 se doplní z tagu — NTFS bit
 * spustitelnosti nemá, takže z disku se přečíst nedá a porovnání dokazuje shodu
 * obsahu, ne módů. Je to jediná přiznaná mez tohohle kroku.
 */
function treeHashOfCheckout(dir, executables) {
  if (existsSync(join(dir, '.git'))) rmSync(join(dir, '.git'), { recursive: true, force: true });
  git(['init', '--quiet'], { cwd: dir });
  git(['-c', 'core.autocrlf=false', '-c', 'core.fileMode=false', 'add', '-A'], { cwd: dir });
  for (const path of executables) {
    if (existsSync(join(dir, path))) git(['update-index', '--chmod=+x', path], { cwd: dir });
  }
  return git(['write-tree'], { cwd: dir });
}

/**
 * Guard, který v běžícím artefaktu neotevře TCP mimo loopback.
 *
 * Rozhodovací funkce se vkládá zdrojem z `prove-fallback-isolation.mjs`, takže
 * běží přesně ten kód, který je pod testy T204. Na konci je pozitivní kontrola:
 * guard, který nechytá nic, vypadá při běhu stejně jako guard, který funguje.
 */
const NETWORK_GUARD = `
import net from 'node:net';

${isLocalConnect.toString()}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  if (!isLocalConnect(args)) throw new Error('build-from-tag guard: outbound connection is blocked');
  return original.apply(this, args);
};

for (const attempt of [
  () => net.connect({ host: '192.0.2.1', port: 80 }),
  () => net.connect({ host: '192.0.2.1', port: 80, path: '/' }),
  () => net.createConnection(80, '192.0.2.1'),
]) {
  let blocked = false;
  try { attempt(); } catch { blocked = true; }
  if (!blocked) {
    console.error('build-from-tag guard: self-check failed, outbound connection was allowed');
    process.exit(3);
  }
}
`;

async function waitForServer(port, child, route) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server skončil dřív, než odpověděl (kód ${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      if (response.status < 500) return;
    } catch {
      // ještě neposlouchá
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('server neodpověděl do 120 s');
}

/**
 * Jeden build z rozbaleného archivu. Vrací otisk artefaktu a množinu proměnných,
 * kterou build o sobě nahlásil.
 */
async function buildOnce(dir, allow, treeHash, surrounding, label) {
  rmSync(join(dir, '.next'), { recursive: true, force: true });
  const reportFile = join(mkdtempSync(join(tmpdir(), 'build-env-')), 'seen.txt');
  const env = {
    ...envFrom(allow.host, surrounding),
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    WORLDSMITH_BUILD_TREE: treeHash,
    WORLDSMITH_ENV_REPORT: reportFile,
  };

  say(`${label}: pipeline předává ${Object.keys(env).length} proměnných`);
  await run(
    `build ${label}`,
    process.execPath,
    [join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', '--webpack'],
    { cwd: dir, env },
  );

  if (!existsSync(reportFile)) {
    throw new Error(`${label}: build nenahlásil svoje prostředí — next.config.mjs neběžel, nebo ho tag nemá`);
  }
  // Report se **připisuje** z každého procesu, který `next.config.mjs` načte.
  // Přepisování by nechalo vidět jen posledního zapisovatele, tedy náhodného
  // workera — a sjednocení všech je právě to, na co se tenhle krok ptá.
  const observed = [...new Set(readFileSync(reportFile, 'utf-8').split('\n').filter((key) => key !== ''))].sort();
  const unexpected = unexpectedEnvKeys(allow.all, observed);
  if (unexpected.length > 0) {
    throw new Error(`${label}: build viděl proměnné mimo allowlist: ${unexpected.join(', ')}`);
  }
  rmSync(dirname(reportFile), { recursive: true, force: true });

  const files = walkFiles(join(dir, '.next'), '', ARTIFACT_SKIP);
  say(`${label}: ${observed.length} viditelných proměnných, ${files.length} souborů artefaktu`);
  return { hashes: hashFiles(join(dir, '.next'), files), observed };
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'fallback-tag-'));
  const checkout = join(work, 'tree');
  const tarball = join(work, `${TAG}.tar`);

  try {
    step(1, 'předpoklady: čistý strom a anotovaný tag');
    const dirty = git(['status', '--porcelain']);
    if (dirty !== '') throw new Error(`pracovní strom není čistý:\n${dirty}`);
    if (git(['cat-file', '-t', TAG]) !== 'tag') {
      throw new Error(`${TAG} není anotovaný tag — lehký tag nenese ani zprávu, ani podpis`);
    }
    const tagTree = git(['rev-parse', `${TAG}^{tree}`]);
    const tagCommit = git(['rev-parse', `${TAG}^{commit}`]);
    const annotation = git(['tag', '-l', '--format=%(contents)', TAG]);
    if (!annotation.includes(tagTree)) {
      throw new Error(`anotace tagu ${TAG} nenese hash stromu ${tagTree}`);
    }
    say(`${TAG} → commit ${tagCommit.slice(0, 12)}, strom ${tagTree.slice(0, 12)}`);

    step(2, 'git archive do prázdného adresáře');
    git(['archive', '--format=tar', '-o', tarball, TAG]);
    extractArchive(tarball, checkout);
    const executables = executablePaths(git(['ls-tree', '-r', TAG]));
    say(`rozbaleno do ${checkout}, ${executables.length} souborů se spustitelným bitem`);

    step(3, 'hash stromu z bajtů na disku');
    const diskTree = treeHashOfCheckout(checkout, executables);
    if (diskTree !== tagTree) {
      throw new Error(`rozbalený strom má hash ${diskTree}, tag ${TAG} nese ${tagTree}`);
    }
    say(`disk se rovná stromu tagu: ${diskTree}`);

    step(4, 'zámek prostředí a offline instalace závislostí');
    const allow = parseAllowlist(readFileSync(join(checkout, ALLOWLIST_FILE), 'utf-8'));
    say(`${ALLOWLIST_FILE} z tagu: ${allow.host.length} předávaných + ${allow.platform.length} od platformy`);
    // Cesta k npm cache je **fakt o stroji**, ne vstup buildu, a předává se
    // proto přepínačem, ne proměnnou: v zamčeném prostředí si ji npm neodvodí
    // (naměřeno — `--offline` skončí na `ENOTCACHED` u prvního tarballu) a
    // pustit kvůli tomu `npm_config_*` do prostředí by tentýž řetěz proměnných
    // dal i `next build`. Co se z cache nainstaluje, určuje `package-lock.json`
    // uvnitř tagu; cache je jen sklad, ze kterého se to bere.
    const npmCache = execFileSync('npm', ['config', 'get', 'cache'], {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    }).trim();
    await run('npm ci', 'npm', ['ci', '--offline', '--no-audit', '--no-fund', '--cache', npmCache], {
      cwd: checkout,
      env: { ...envFrom(allow.host, process.env), NODE_ENV: 'development' },
      shell: process.platform === 'win32',
    });

    step(5, 'první build ze zamčeného prostředí');
    const first = await buildOnce(checkout, allow, diskTree, process.env, 'build 1');

    step(6, 'druhý build v jinak nastaveném okolním prostředí');
    // Archiv se rozbalí znovu přes týž adresář, takže zdrojové bajty jsou
    // čerstvé; `node_modules` zůstává, protože je pinuje lockfile uvnitř tagu.
    extractArchive(tarball, checkout);
    const again = treeHashOfCheckout(checkout, executables);
    if (again !== tagTree) throw new Error(`druhé rozbalení dalo jiný strom: ${again}`);
    const polluted = { ...process.env, ...POLLUTION };
    const second = await buildOnce(checkout, allow, diskTree, polluted, 'build 2');

    // **Záporná kontrola, ne naděje.** Bez ní by „prostředí je zamčené" stálo
    // na tom, že filtr filtruje — což je tvrzení o filtru, ne o buildu. Tady se
    // ptáme buildu samotného, jestli některé z podstrčených jmen viděl. Ta jména
    // jsou schválně mimo sekci `[platform]`, aby je nemohl přidat OS ani Next.
    const leaked = Object.keys(POLLUTION).filter((name) =>
      second.observed.some((seen) => seen.toUpperCase() === name.toUpperCase()),
    );
    if (leaked.length > 0) {
      throw new Error(`podstrčené proměnné prošly do buildu: ${leaked.join(', ')}`);
    }
    say(`zamčené prostředí drží: ${Object.keys(POLLUTION).length} podstrčených jmen build neviděl`);

    const drift = diffHashes(first.hashes, second.hashes);
    const total = drift.onlyFirst.length + drift.onlySecond.length + drift.changed.length;
    if (total > 0) {
      // Jméno souboru samo o sobě nestačí: rozdíl bývá jedna hodnota v manifestu
      // a bez ní se nedá rozhodnout, jestli je to vygenerovaný klíč nebo změna
      // chování. Druhý artefakt je v `.next`, první už přepsaný, takže se ukáže
      // aspoň to, co v něm na tom místě stojí.
      const detail = [...drift.changed, ...drift.onlyFirst, ...drift.onlySecond]
        .slice(0, 10)
        .map((file) => {
          const path = join(checkout, '.next', file);
          if (!file.endsWith('.json') || !existsSync(path)) return `  ${file}`;
          return `  ${file}\n      build 2: ${readFileSync(path, 'utf-8').slice(0, 300)}`;
        });
      throw new Error(`dva buildy z téhož archivu se liší v ${total} souborech:\n${detail.join('\n')}`);
    }
    say(`reprodukovatelné: ${Object.keys(first.hashes).length} souborů bit po bitu shodných`);

    step(7, 'spustit ten artefakt bez cesty ven a projet smoke');
    const guardDir = mkdtempSync(join(tmpdir(), 'fallback-tag-guard-'));
    const guardFile = join(guardDir, 'no-outbound.mjs');
    writeFileSync(guardFile, NETWORK_GUARD, 'utf-8');
    const port = await freePort();
    const server = spawn(
      process.execPath,
      [join(checkout, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: checkout,
        env: {
          ...scrubbedEnv(process.env),
          NODE_ENV: 'production',
          NODE_OPTIONS: `--import ${pathToFileURL(guardFile).href}`,
        },
        stdio: 'inherit',
      },
    );

    try {
      await waitForServer(port, server, FALLBACK_ROUTE);
      const base = `http://127.0.0.1:${port}`;
      say(`artefakt běží na ${base}`);

      const served = await (await fetch(`${base}/api/build-id`)).json();
      if (served.tree !== diskTree) {
        throw new Error(`/api/build-id vrací ${served.tree}, čekal se strom checkoutu ${diskTree}`);
      }
      say(`/api/build-id → ${served.tree}`);

      await run('smoke', 'npx', ['playwright', 'test', 'e2e/fallback-smoke.spec.ts'], {
        cwd: ROOT,
        env: { ...process.env, FALLBACK_SMOKE_URL: base, FALLBACK_SMOKE_TREE: diskTree },
        shell: process.platform === 'win32',
      });
    } finally {
      server.kill();
      rmSync(guardDir, { recursive: true, force: true });
    }

    step(8, 'zapsat zámek');
    const lock = {
      note:
        'Vazba tagu na artefakt. Píše scripts/build-from-tag.mjs. Hash stromu ' +
        'vzniká z bajtů rozbaleného archivu, ne z tagu — směr od vstupu buildu.',
      tag: TAG,
      commit: tagCommit,
      tree: diskTree,
      allowlist: allow,
      npmCache,
      pollutionRejected: Object.keys(POLLUTION),
      envSeenByBuild: first.observed,
      artifactFiles: Object.keys(first.hashes).length,
      artifactSha256: first.hashes,
    };
    mkdirSync(join(ROOT, dirname(LOCK_FILE)), { recursive: true });
    writeFileSync(join(ROOT, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');
    say(`${LOCK_FILE}: ${Object.keys(first.hashes).length} otisků`);

    process.stdout.write(`\n✅ ${TAG} se postavil z vlastního stromu, reprodukovatelně, a obsloužil smoke\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`\n❌ ${error.message}\n`);
    process.exitCode = 1;
  });
}
