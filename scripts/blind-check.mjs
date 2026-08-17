#!/usr/bin/env node
/**
 * Kontrola před nahráním: neprozrazuje repozitář autora?
 *
 * `RULES.md` §6 vyžaduje slepé hodnocení — hodnotitel nesmí z odevzdaných
 * artefaktů poznat, kdo je autor. Po prvním pushi se to zpětně nespraví:
 * historie je veřejná a přepis zanechá viditelnou stopu. Tenhle skript je
 * proto brána, ne úklid, a běží v `pre-push` hooku (`.githooks/pre-push`).
 *
 * Skončí `0`, když neselže žádná kontrola, jinak `1`.
 *
 * **Dva režimy.** Z hooku (`BLIND_CHECK_HOOK` nastavená, argumenty od gitu)
 * běží všech šest kontrol včetně cíle pushe. Ručně spuštěný skript cíl pushe
 * nezná, takže kontrola 5 se přeskočí a napíše to — zbylých pět je pořád
 * užitečná odpověď na „je repozitář čistý".
 *
 * **Skript sám je veřejný, takže v něm nesmí stát skutečné jméno autora.**
 * Zakázané tokeny pro identitu se proto čtou z `blind-check.config.json`,
 * který je v `.gitignore` — a kontrola 1 navíc selže, kdyby se ten soubor
 * někdy ocitl mezi trackovanými.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const CONFIG_FILE = 'blind-check.config.json';

/** Tyhle dva se nekonfigurují — vypnout je by znamenalo vypnout smysl kontroly 3. */
const PUBLIC_TOKENS = ['acmecorp', 'acme'];

/**
 * **Od jaké délky se token hledá jako podřetězec.** Kratší se hledá na hranici
 * slova (`git grep -w`). Pravidlo stojí tady, ne aby se odvozovalo z chování,
 * protože bez něj se seznam tiše zúží — a zúžený seznam vypadá jako čistý repo.
 *
 * **Naměřeno 17. 8. 2026 nad celou historií** (139 revizí, jednotka je dvojice
 * `revize:cesta`): `identityTokens` mají délky 9, 8, 7, 7, 5 a 3. Tříznakový
 * token sedí jako **podřetězec na 540 míst**, jako **celé slovo na 2** — a ta
 * dvě místa jsou tatáž, na kterých ho najdou i oba dlouhé tokeny, tedy skutečný
 * nález. Brána, která hlásí 540 zásahů pokaždé, se přestane rozlišovat od
 * úniku a někdo ji obejde `--no-verify` — což vypne i clean-room kontrolu vedle.
 *
 * **Co se tím vzdává, řečeno nahlas:** u tokenu kratšího než pět znaků projde
 * slitý tvar (`<token>hackathon`). U delších ne — ty se pořád hledají jako
 * podřetězec, takže `jmenoautora-hra.git` i `jmenoautora@x.io` jsou nález.
 */
const SUBSTRING_MIN_LEN = 5;

/**
 * Běží skript jako `pre-push` hook, nebo ho někdo spustil rukou?
 *
 * Rozhoduje **prostředí, ne přítomnost argumentů**. Kdyby se hookem rozumělo
 * „přišel aspoň jeden argument", stačilo by hook rozbít tak, aby argumenty
 * zahodil, a kontrola cíle by se tiše proměnila v ruční běh, který nekontroluje
 * nic. Takhle je chybějící adresa uvnitř hooku selhání.
 */
const HOOK_MODE = Boolean(process.env.BLIND_CHECK_HOOK);

/**
 * `$2` z `pre-push`: adresa, na kterou git skutečně pushuje. Honoruje i
 * `remote.<jméno>.pushurl`, takže je to přesnější zdroj než `git remote -v`.
 * `$1` je jen lokální jméno remote a ven nejde, proto se nesoudí.
 */
const PUSH_TARGET = (process.argv[3] ?? '').trim();

/** Kontrola, která v tomhle režimu nemá co měřit. Není to PASS ani FAIL. */
const skip = (reason) => ({ skipped: reason });

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

/**
 * `git grep` přes CELOU dosažitelnou historii, po dávkách.
 *
 * Dvě věci, které naivní verze nezvládla a obě končily tichou zelenou:
 *
 * 1. **Délka argv.** Revize se předávají jako argumenty, a Windows má na
 *    `CreateProcess` tvrdý limit. Naměřeno: 700 revizí vrátilo 78 zásahů, 800
 *    revizí nula — `execFileSync` vyhodil a kontrola prohlásila za čistou
 *    historii, kterou vůbec neotevřela. Proto dávky.
 * 2. **Chyba vs. žádná shoda.** `git grep` vrací 1, když nenašel nic, a ≥2 při
 *    chybě. Slít obojí do prázdného řetězce znamená číst rozbitý běh jako čistý.
 *    Chyba se proto vyhazuje a hlásí jako selhání kontroly.
 */
function grepHistory(patterns, pathspec, { extended = false, word = false, namesOnly = false } = {}) {
  // BEZ `allowFail`. Prázdný výstup smí znamenat „repozitář nemá commity" jenom
  // tehdy, když git skončil nulou; rozbitý ref nebo chybějící objekt by se jinak
  // četl jako čistá historie — a to je právě ta tichá zelená, kterou tahle
  // funkce zavírá o dva řádky níž u `git grep`.
  let listing;
  try {
    listing = git(['rev-list', '--all']);
  } catch (error) {
    throw new Error(`historii se nepodařilo přečíst (${String(error.message).split('\n')[0]})`);
  }
  const revisions = listing.trim().split('\n').filter(Boolean);
  if (revisions.length === 0) return '';

  // Dávku smí test zmenšit, nikdy zvětšit — jinak by seam uměl vrátit tu vadu,
  // kvůli které tu je. 160 commitů jen kvůli překročení hranice by stálo 26 s.
  //
  // **Co je a co není otestované:** testem je pokryté to, že se prochází i další
  // dávky (zásah v druhé se najde). Samotná hodnota 150 pokrytá NENÍ — hranice
  // argv leží mezi 700 a 800 revizemi a repozitář by kvůli tomu musel mít osm
  // set commitů. Mutant, který dávku zvětší na celou historii, proto v testu
  // přežije; je to omezení měřítka, ne děravé tvrzení.
  const requested = Number(process.env.BLIND_CHECK_REV_CHUNK);
  const CHUNK = Number.isInteger(requested) && requested > 0 ? Math.min(150, requested) : 150;

  // Dávky se sčítají, nevrací se první nalezená. Počet zásahů čte člověk, aby
  // odhadl, kolik toho musí z historie vyndat; číslo z jedné dávky by ho podhodnotilo.
  const hits = [];
  for (let start = 0; start < revisions.length; start += CHUNK) {
    // `-l` místo `-n`: u hledání identity se nesmí vypsat nalezený řádek. Ten
    // řádek je právě to jméno, které se schovává, a výpis brány jde do
    // terminálu, do logu hooku a do CI. Nález se hlásí cestou, ne obsahem.
    const args = ['grep', `-I${namesOnly ? 'l' : 'n'}i${extended ? 'E' : ''}`];
    if (word) args.push('-w');
    for (const pattern of patterns) args.push('-e', pattern);
    args.push(...revisions.slice(start, start + CHUNK), '--', ...pathspec);

    // `spawnSync`, ne `execFileSync`: potřebujeme stderr i u nulového návratu.
    const result = spawnSync('git', ['--no-replace-objects', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    // **Návratový kód sám nestačí a je to ta nejtišší past v celém souboru.**
    // `git grep` vrací 1 jak při „žádná shoda", tak když některý blob nešlo
    // přečíst — nečitelný objekt jen ohlásí na stderr a jede dál. Naměřeno na
    // repozitáři se smazaným loose objektem: `error: '<rev>:a.txt': unable to
    // read <oid>`, exit 1. Číst to jako čistou historii by znamenalo hlásit
    // zelenou nad soubory, které nikdo neotevřel.
    const stderr = String(result.stderr ?? '').trim();
    if (result.error || stderr || (result.status !== 0 && result.status !== 1)) {
      const why = stderr.split('\n')[0] || result.error?.message || `git skončil s kódem ${result.status}`;
      throw new Error(`git grep nad historií selhal (${why})`);
    }
    if (result.status === 0) {
      const output = String(result.stdout ?? '').trim();
      if (output) hits.push(output);
    }
  }
  return hits.join('\n');
}

/**
 * Každá cesta, která kdy vstoupila do libovolného commitu — ne jen ta, která je
 * ve stromu `HEAD`. Soubor přidaný a v dalším commitu smazaný se nahraje stejně
 * jistě jako ten, co zůstal; `git ls-tree HEAD` o něm neví.
 *
 * **`--no-renames` a `-m` nejsou kosmetika, bez nich to lže.** `--diff-filter=A`
 * čte diffy, ne stromy, a diff dvě věci mlčky vynechá:
 *
 * 1. **Přejmenování.** `git mv notes.txt .env.local` je pro git status `R`, ne
 *    `A`, takže `.env.local` se v seznamu neobjeví — přestože v `HEAD` je a
 *    nahraje se. Naměřeno: soubor s `DB_PASSWORD` a `AWS_SECRET_ACCESS_KEY`
 *    prošel všemi šesti kontrolami. `--no-renames` z toho udělá zase `A`.
 * 2. **Merge commity.** Bez `-m` u nich `--name-only` nevypíše nic, takže cesta
 *    přidaná jen v merge commitu (evil merge) v seznamu chybí ze stejného důvodu.
 *
 * Pravidla kontroly 6 jsou čistě podle cesty, takže vynechanou cestu už nic
 * jiného nechytí. `-z` kvůli diakritice: jinak git cesty uvozuje a vedoucí
 * uvozovka rozbije porovnání vzorů.
 *
 * BEZ `allowFail` — ze stejného důvodu jako `rev-list` v `grepHistory`. Useknutý
 * výpis (chybějící objekt, `maxBuffer`) by se jinak četl jako úplná historie.
 * **Vlastní test na to není a mutant tady přežije:** každou porušenou historii,
 * kterou jde v tomhle repu postavit, shodí až `grepHistory` na konci kontroly, a
 * tvar, který by ji neshodil, potřebuje výpis přes 64 MB. Je to obrana do
 * hloubky, ne doložené tvrzení, a tahle věta to říká místo zelené, která by
 * netvrdila nic.
 */
function historyPaths() {
  const listing = git([
    'log',
    '--all',
    '--full-history',
    '--no-renames',
    '-m',
    '--diff-filter=A',
    '--name-only',
    '--format=',
    '-z',
  ]);
  return [...new Set(listing.split('\0').map((line) => line.trim()).filter(Boolean))];
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

check(3, 'committed content mentions neither AcmeCorp nor the real author', (config) => {
  // Fail-closed: bez configu se identita nedá hledat vůbec. Mlčení by tady
  // znamenalo zelenou nad kontrolou, která polovinu své práce neudělala.
  if (config.error) return config.error;

  // Nad `HEAD`, ne nad pracovním stromem: nahrávají se commity. Interní podklady
  // (`plans/`, kořenové `*.md`, `.claude/`) jsou v `.gitignore`, takže trackované
  // nejsou a do commitu se nedostanou.
  // Dva soubory se vylučují, protože ty tokeny obsahovat MUSÍ: skript sám je má
  // v `PUBLIC_TOKENS` a v názvu kontroly, jeho test je má ve fixturách. Bez téhle
  // výjimky hlásí kontrola 3 nenulový počet vždycky — a když je nenulová pořád,
  // přestane se rozlišovat od skutečného úniku a člověk pushne s `--no-verify`.
  // Naměřeno: 6 vlastních zásahů maskovalo 13 skutečných.
  // Nad VŠEMI dosažitelnými commity, ne jen nad `HEAD`. Push nahrává historii,
  // ne snímek: jméno vyškrtnuté v posledním commitu drží jeho rodič dál a
  // `git log -p` ho ukáže komukoli. Kontrola 4 vedle chodí přes `--all` ze
  // stejného důvodu.
  const output = grepHistory(PUBLIC_TOKENS, [
    '.',
    ':(exclude)SECURITY-FINDINGS.md',
    ':(exclude)scripts/blind-check.mjs',
    ':(exclude)scripts/__tests__/blind-check.test.ts',
  ]);

  /**
   * **Jméno autora se hledá tady, ne jen v identitě commitu.** Kontrola 1 kryje
   * `%an`/`%ae`, kontrola 5 adresu remote — obsah zůstal do 17. 8. 2026 na
   * `acmecorp|acme`, takže commit se skutečným jménem v `README.md`, v
   * `package.json` → `author` nebo v komentáři prošel všemi šesti kontrolami
   * zeleně. **A neprošel hypoteticky:** první běh s touhle částí našel v historii
   * dvě místa, která šest kontrol před ním nevidělo — soubor smazaný v `HEAD`,
   * ale živý ve svém rodiči. Nad trackovaným stromem je zásahů pořád nula, takže
   * hledat jen v `HEAD` by nenašlo nic a tvářilo se to jako čistý repozitář.
   *
   * Výjimky pro vlastní soubory se tu **nedělají**: skript ani jeho test skutečné
   * jméno obsahovat nemají, a kdyby ho obsahovaly, je to nález.
   */
  const identity = (config.identityTokens ?? []).filter(Boolean);
  const long = identity.filter((token) => token.length >= SUBSTRING_MIN_LEN);
  const short = identity.filter((token) => token.length < SUBSTRING_MIN_LEN);
  const identityHits = [
    ...(long.length ? [grepHistory(long, ['.'], { namesOnly: true })] : []),
    ...(short.length ? [grepHistory(short, ['.'], { namesOnly: true, word: true })] : []),
  ]
    .filter(Boolean)
    .join('\n');

  const problems = [];
  if (output) {
    const lines = output.split('\n');
    problems.push(`${lines.length} zásahů jména organizátora v historii, první: ${lines[0].slice(0, 160)}`);
  }
  if (identityHits) {
    // Jen `<revize>:<cesta>`, nikdy nalezený řádek — viz `namesOnly` v grepHistory.
    const places = [...new Set(identityHits.split('\n').filter(Boolean))];
    problems.push(`${places.length} míst v historii nese jméno autora, první: ${places[0]}`);
  }
  return problems.length ? problems.join('; ') : null;
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

check(5, 'push target points at the anonymous account', (config) => {
  // Ruční spuštění cíl pushe nezná a vymyslet si ho nesmí. `git remote -v` tu
  // dřív stál jako náhrada a byl to průchod: `git push https://github.com/
  // <skutečné-jméno>/x.git HEAD` prohlédne nastavený čistý remote, projde, a
  // push jde ven pod adresou se jménem. Soudí se výhradně to, co podal git.
  if (!HOOK_MODE) {
    return skip('spuštěno ručně, ne z hooku — cíl pushe zná jen git a nedá se odhadnout');
  }
  if (config.error) return config.error;
  if (!config.account) return `${CONFIG_FILE} neuvádí "account", není proti čemu porovnat`;

  // Fail-closed: hook běží, ale adresu nepodal. To je rozbitý hook, ne čistý
  // repozitář — a mlčení by tady znamenalo push bez jediné kontroly cíle.
  if (!PUSH_TARGET) {
    return 'hook nepředal adresu cíle (`$2`), cíl pushe se ověřit nedá';
  }

  const url = PUSH_TARGET.toLowerCase();
  const expected = config.account.toLowerCase();
  if (!(url.includes(`github.com/${expected}/`) || url.includes(`github.com:${expected}/`))) {
    return `cíl pushe nemíří na očekávaný účet: ${PUSH_TARGET}`;
  }

  // Účet je jen půlka adresy. Jméno repozitáře je ta druhá a jde ven se stejnou
  // jistotou — hodnotitel dostane URL dřív než obsah. Kontrola 3 čte strom, takže
  // token v názvu repa jí projde: strom o svém vlastním URL nic neví.
  //
  // Hledá se TÝŽ seznam jako v kontrole 1, tedy i skutečné jméno autora. Samotné
  // `PUBLIC_TOKENS` nechá projít `github.com/<správný-účet>/<jméno-autora>-hra.git`:
  // účet sedí, jméno organizátora tam není, a jméno autora přesto jde ven.
  const tokens = [...PUBLIC_TOKENS, ...config.identityTokens].filter(Boolean);
  const named = tokens.filter((token) => url.includes(token.toLowerCase()));
  return named.length ? `adresa cíle sama nese zakázaný token: ${PUSH_TARGET}` : null;
});

/**
 * Od T18 nese repozitář poprvé skutečné credentials (`.env.local`) a poprvé
 * syrové odpovědi poskytovatele (`evals/live/`). Obojí brání jen `.gitignore`,
 * a `.gitignore` je jediná editace od toho, aby nebránil nic — `git add -f` ho
 * obejde rovnou. Tahle kontrola je ta druhá vrstva: ptá se, co je doopravdy
 * v historii, ne co má být ignorované.
 *
 * **Celá historie, ne `HEAD`** — přesně jako kontrola 3 a ze stejného důvodu.
 * `git add -f .env.local`, commit, `git rm`, commit: `HEAD` je čistý, klíč je
 * v rodiči a push ho nahraje. Nad `HEAD` se to nedalo poznat.
 */
check(6, 'no credentials or raw run artefacts entered history', () => {
  // `-z`: bez něj git cesty s ne-ASCII znaky uvozuje (`"evals/live/C\305\276.json"`),
  // a vedoucí uvozovka rozbije obě porovnání níž — soubor s diakritikou by
  // branou prošel.
  const tracked = historyPaths();
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

  // Report z vývojového profilu. Leží v `evals/` vedle oficiálního
  // `kill-gate-report.json`, takže commitnutý by v published repu stál přesně
  // tam, kde ho někdo přečte jako výsledek brány. `.gitignore` ho drží venku;
  // tahle kontrola hlídá případ, kdy ho někdo přidá přes `git add -f`.
  const devReports = lower
    .filter(([, path]) => /^evals\/dev-report\..*\.json$/.test(path))
    .map(([original]) => original);
  if (devReports.length > 0)
    return `vývojový report je trackovaný a plete se s výsledkem brány: ${devReports.join(', ')}`;

  // Tvar API klíče kdekoli v commitnuté historii. Klíč smazaný v dalším commitu
  // je pořád klíč, který se nahraje.
  const keys = grepHistory(['sk-[A-Za-z0-9_-]{20,}'], ['.'], { extended: true });
  if (keys) return `commitnutý obsah nese řetězec ve tvaru API klíče: ${keys.split('\n')[0].slice(0, 160)}`;

  return null;
});

const config = loadConfig();
let failed = 0;
let skipped = 0;

console.log('blind-check — RULES.md §6, kontrola před nahráním\n');
for (const { id, title, run } of checks) {
  let detail;
  try {
    detail = run(config);
  } catch (error) {
    detail = `kontrola spadla: ${error.message}`;
  }
  if (detail && detail.skipped) {
    skipped += 1;
    console.log(`SKIP  [${id}] ${title}\n        ${detail.skipped}`);
  } else if (detail) {
    failed += 1;
    console.log(`FAIL  [${id}] ${title}\n        ${detail}`);
  } else {
    console.log(`PASS  [${id}] ${title}`);
  }
}

// Počet se bere z `checks`, ne z konstanty: zapsané číslo se při přidání
// kontroly rozejde se skutečností a hláška pak lže o rozsahu brány.
//
// Přeskočené se jmenují v obou větvích. „Všech 6 kontrol prošlo" nad během,
// kde jedna z nich vůbec neběžela, je přesně to tvrzení, kvůli kterému se na
// bránu někdo spolehne.
const scope = skipped ? ` (${skipped} přeskočeno, neběžela nad tímhle během)` : '';
console.log(
  failed === 0
    ? `\n${checks.length - skipped} z ${checks.length} kontrol prošlo${scope} — push je z hlediska slepého hodnocení v pořádku.`
    : `\n${failed} z ${checks.length} kontrol selhalo${scope}. Push se NEPROVEDE.`,
);
process.exit(failed === 0 ? 0 : 1);
