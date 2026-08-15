#!/usr/bin/env node
/**
 * Clean-room kontrola: neobjevil se v repu identifikátor z proprietárního modulu?
 *
 * Část návrhu vychází z doktríny — z toho, **který výběr událostí, podmínek a
 * akcí se osvědčil u neprogramátorů**. Doktrína se přenášet smí, názvy ne.
 * Repozitář půjde ven jako veřejný, takže přenesený název není licenční detail —
 * je to diskvalifikace a zároveň problém pro držitele práv.
 *
 * ## Co tahle kontrola měří, a co ne — čtěte dřív, než se na ni spolehnete
 *
 * Je to **lexikální shoda proti seznamu identifikátorů**. Nic víc. Bere řádky ze
 * `scripts/cleanroom-forbidden.txt` a hledá je jako celá slova v pracovním stromě.
 *
 * **Přepsaný kód se stejnou strukturou a jinými názvy tahle brána nechytí.**
 * Neměří podobnost obsahu, nepočítá žádný „práh podobnosti" a žádný takový
 * neslibuje. Proti záměrnému obejití neobstojí; obstojí proti tomu, co se opravdu
 * stává — proti zapomenutému názvu ve zkopírovaném útržku.
 *
 * ## Fail-closed, a proč zrovna tady
 *
 * Seznam je v `.gitignore`, protože sám nese proprietární názvy. Znamená to, že
 * na čerstvém klonu **chybí** — a kontrola, která by v tu chvíli mlčky prošla, by
 * byla nejnebezpečnější variantou ze všech: vypadala by jako brána a nebyla by
 * žádná. Chybějící i prázdný seznam jsou proto selhání.
 *
 * Provisioning nového stroje: `ops/cleanroom-provisioning.md`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const LIST_FILE = 'scripts/cleanroom-forbidden.txt';
const PROVISIONING = 'ops/cleanroom-provisioning.md';

/**
 * Direktiva, se kterou se seznam rodí: *„tenhle seznam ještě nikdo nenaplnil"*.
 *
 * **Je to komentář, ne identifikátor, a je to podstatné.** První verze tady měla
 * zástupné *jméno* (`CLEANROOM_CANARY_…`) a shodila si vlastní commit — to jméno
 * totiž stálo v tomhle skriptu, v provisioning dokumentu i v testech, takže je
 * skener našel jako nález a brána zablokovala všechno. Zástupné jméno na seznamu
 * jmen je z principu vlastní gól. Direktiva se nehledá, protože `parseList` ji
 * zahazuje jako komentář.
 *
 * Řeší rozpor mezi dvěma pravdivými požadavky: **prázdný seznam je selhání**
 * (projde čímkoli, tedy žádná kontrola) a **na nenaplněném repu se musí dát
 * commitovat**. Nenaplněný stav se proto musí *přiznat*, ne mlčet.
 *
 * Přiznat ale nestačí: direktiva sama končila nulou, takže brána nad prázdným
 * seznamem hlásila počet prohledaných souborů a pouštěla dál úplně všechno.
 * Nenaplněný seznam proto **selhává** stejně jako chybějící a průchod si musí
 * vyžádat ten, kdo commituje — proměnnou prostředí níž, kterou hook nenastavuje.
 *
 * Proti záměru tahle brána neobstojí tak jako tak (viz hlavička).
 */
const UNPROVISIONED = '#!unprovisioned';

/** Vědomé, na jedno spuštění platné obejití nenaplněného seznamu. */
const UNPROVISIONED_WAIVER = 'CLEANROOM_ALLOW_UNPROVISIONED';

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|glb|gltf|bin|zip|gz|pdf|node|wasm|tsbuildinfo)$/i;

/**
 * Řádky seznamu. `#` je komentář, prázdné řádky se ignorují. Zbytek je jeden
 * identifikátor na řádek.
 */
export function parseList(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** Nese seznam direktivu „ještě nenaplněno"? Hledá se mezi komentáři, ne mezi jmény. */
export function isUnprovisioned(text) {
  return text.split('\n').some((line) => line.trim().toLowerCase() === UNPROVISIONED);
}

/**
 * Celá slova, ne podřetězce. Bez hranic by `Actor` trefil `Actors`, `Reactor` i
 * `ActorId` a brána by hlásila tolik falešných nálezů, že by ji někdo vypnul —
 * což je horší výsledek než mít ji volnější.
 */
export function findHits(text, identifiers) {
  const hits = [];
  const lines = text.split('\n');
  for (let index = 0; index < identifiers.length; index += 1) {
    const identifier = identifiers[index];
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`);
    for (let row = 0; row < lines.length; row += 1) {
      // `index` je pozice v seznamu — hlásí se místo jména, aby se do logu
      // nedostal proprietární identifikátor. `identifier` zůstává pro testy.
      if (pattern.test(lines[row])) hits.push({ identifier, index, line: row + 1 });
    }
  }
  return hits;
}

/**
 * Skenují se **soubory, které jsou v repu nebo do něj můžou vstoupit** — tedy
 * trackované plus untrackované neignorované (`git ls-files -c -o
 * --exclude-standard`). Ne celý pracovní strom, a to ze dvou důvodů:
 *
 * 1. **Ignorované soubory tuhle bránu zajímat nesmějí.** Pracovní strom nese
 *    vedle produktu i interní podklady, které klidně můžou nést jméno z
 *    proprietárního modulu. Při skenu celého stromu by hlásily nález při každém
 *    commitu — a jediná cesta k zelené by bylo je smazat nebo bránu vypnout.
 *    Commitnout se stejně nedají, takže hlídat je není k čemu.
 * 2. Sken celého stromu je řádově dražší a `pre-commit` běží při každém commitu.
 *
 * `--no-replace-objects` ze stejného důvodu jako v `blind-check.mjs`: `git
 * replace` umí podstrčit jiné bajty pod nezměněné OID.
 */
function git(args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: REPO,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Obsah se čte z **indexu**, ne z pracovního stromu — commituje se index.
 *
 * Naměřeno reviewem nad `47e0b02`: brána brala jména z `git ls-files`, ale bajty
 * z disku. Stačilo `git add` souboru se zakázaným jménem a pak ten soubor na
 * disku opravit; gate hlásil `žádný nález`, exit 0, a `git show :<cesta>` přitom
 * to jméno pořád držel. Nejde o exotický útok — je to obyčejné pořadí kroků:
 * brána zaječí, člověk soubor opraví, zapomene `git add`, commitne znovu, zelená.
 *
 * Netrackované neignorované soubory se čtou z disku, protože v indexu nejsou a
 * `git add -A` je tam za chvíli dostane.
 */
function scannedFiles() {
  let stagedListing;
  let untrackedListing;
  try {
    stagedListing = git(['ls-files', '-s', '-z']).toString('utf8');
    untrackedListing = git(['ls-files', '-o', '--exclude-standard', '-z']).toString('utf8');
  } catch (error) {
    // Fail-closed i tady: bez seznamu souborů kontrola neví, co skenovala, a
    // tichý průchod nad prázdnou množinou by vypadal jako čistý strom.
    return { error: `git ls-files selhal (${error.message.split('\n')[0]}) — bez seznamu souborů se nedá skenovat` };
  }

  const staged = [];
  for (const record of stagedListing.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const shown = record.slice(tab + 1);
    const oid = record.slice(0, tab).split(/\s+/)[1];
    // Seznam sám ty identifikátory nese z definice. Kdyby se skenoval, hlásil
    // by nález na každém spuštění a jediná cesta k zelené by bylo ho vyprázdnit.
    if (!oid || BINARY.test(shown) || shown === LIST_FILE) continue;
    staged.push({ shown, oid });
  }

  const files = [];
  if (staged.length > 0) {
    // Jedno volání místo jednoho procesu na soubor: 190 spawnů by z `pre-commit`
    // udělalo něco, co lidi vypínají.
    const contents = readBlobs(staged.map((entry) => entry.oid));
    if (contents.error) return contents;
    for (let index = 0; index < staged.length; index += 1) {
      files.push({ shown: staged[index].shown, text: contents.blobs[index] });
    }
  }

  for (const shown of untrackedListing.split('\0')) {
    if (!shown || BINARY.test(shown) || shown === LIST_FILE) continue;
    try {
      files.push({ shown, text: readFileSync(join(REPO, shown), 'utf8') });
    } catch {
      // Nečitelný netrackovaný soubor se počítá jako přeskočený, ne jako čistý.
      files.push({ shown, text: null });
    }
  }
  return { files };
}

/**
 * Roztřídí přečtené soubory na nálezy a na ty, které se přečíst nepodařilo.
 *
 * Vytažené ven kvůli testu: nečitelný soubor (exkluzivní zámek, EACCES, visící
 * symlink, soubor smazaný mezi výpisem a čtením) se na Windows nedá vyrobit
 * spolehlivě, takže integrační cesta by tuhle větev buď netestovala vůbec, nebo
 * jen na Linuxu — a zelená, která na téhle mašině netvrdí nic, je horší než
 * žádná. Testuje se proto rozhodnutí, ne způsob, jak soubor znečitelnit.
 */
function verdict(scannedFilesList, identifiers) {
  let files = 0;
  const skipped = [];
  const findings = [];
  for (const file of scannedFilesList) {
    if (file.text === null) {
      skipped.push(file.shown);
      continue;
    }
    files += 1;
    for (const hit of findHits(file.text, identifiers)) findings.push({ ...hit, file: file.shown });
  }
  // `blocked` je celé rozhodnutí brány nad naskenovanou množinou, ne jen počet
  // nálezů: nepřečtený soubor musí běh zastavit stejně jako nález.
  return { files, skipped, findings, blocked: findings.length > 0 || skipped.length > 0 };
}

/** Obsah blobů v pořadí zadaných oidů, jedním `git cat-file --batch`. */
function readBlobs(oids) {
  try {
    const out = execFileSync('git', ['--no-replace-objects', 'cat-file', '--batch', '--buffer'], {
      cwd: REPO,
      // `input` musí být Buffer: se stringem si ho Node vyrábí přes
      // `Buffer.from(input, encoding)` a na `encoding: 'buffer'` padne.
      input: Buffer.from(`${oids.join('\n')}\n`, 'utf8'),
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    });
    const blobs = [];
    let offset = 0;
    while (offset < out.length && blobs.length < oids.length) {
      const newline = out.indexOf(0x0a, offset);
      if (newline < 0) break;
      const header = out.slice(offset, newline).toString('utf8');
      const size = Number(header.split(' ')[2]);
      const start = newline + 1;
      blobs.push(out.slice(start, start + size).toString('utf8'));
      offset = start + size + 1;
    }
    if (blobs.length !== oids.length) {
      return { error: `git cat-file vrátil ${blobs.length} objektů místo ${oids.length}` };
    }
    return { blobs };
  } catch (error) {
    return { error: `git cat-file selhal (${error.message.split('\n')[0]})` };
  }
}

/**
 * Seznam nesmí být trackovaný. `.gitignore` je proti `git add -f` bezmocný a
 * `blind-check.mjs:54` má přesně tuhle pojistku pro svůj vlastní config —
 * tenhle soubor je citlivější a neměl ji.
 */
function listIsTracked() {
  try {
    execFileSync('git', ['--no-replace-objects', 'ls-files', '--error-unmatch', LIST_FILE], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function main(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'cleanroom-check — hlídá identifikátory z proprietárního modulu třetí strany',
        '',
        '  node scripts/cleanroom-check.mjs',
        '',
        'JE TO LEXIKÁLNÍ SHODA PROTI SEZNAMU JMEN, ne měření podobnosti obsahu.',
        'Hledá celá slova ze seznamu v obsahu INDEXU (commituje se index, ne disk).',
        'Netrackované neignorované soubory se čtou z disku. Přepsaný kód se stejnou',
        'strukturou a jinými názvy tímhle NEPROJDE JAKO NÁLEZ — a nesmí se na to',
        'spoléhat, jako by prošel kontrolou podobnosti. Žádný „práh podobnosti"',
        'se nepočítá a žádný se neslibuje.',
        '',
        `Seznam: ${LIST_FILE} (mimo verzování). Chybějící NEBO prázdný seznam je`,
        'selhání, nikdy přeskočení. Jediná výjimka je seznam, který se k tomu',
        `přizná direktivou ${UNPROVISIONED} — ten projde, ale hlásí to na každém`,
        `běhu. Provisioning: ${PROVISIONING}`,
      ].join('\n'),
    );
    return 0;
  }

  console.log('cleanroom-check — clean-room doktrína, lexikální shoda proti seznamu jmen\n');

  // Dřív než cokoli jiného: seznam sám se nesmí ocitnout v repu. `.gitignore` je
  // proti `git add -f` bezmocný a tenhle soubor je to nejcitlivější v celém stromě.
  if (listIsTracked()) {
    console.log(
      `FAIL  ${LIST_FILE} je TRACKOVANÝ.\n` +
        '        Nese proprietární jména a repozitář půjde ven — commitnutý seznam vynáší\n' +
        `        přesně to, čemu má bránit. Vyndej ho: git rm --cached ${LIST_FILE}`,
    );
    return 1;
  }

  const listPath = join(REPO, LIST_FILE);
  if (!existsSync(listPath)) {
    console.log(
      `FAIL  seznam ${LIST_FILE} chybí.\n` +
        '        Kontrola se NEPŘESKAKUJE — bez seznamu neví, co hledat, a tichý průchod\n' +
        `        by vypadal jako brána, která žádná není. Provisioning: ${PROVISIONING}`,
    );
    return 1;
  }

  const raw = readFileSync(listPath, 'utf8');
  const identifiers = parseList(raw);
  const unprovisioned = isUnprovisioned(raw);

  if (identifiers.length === 0 && !unprovisioned) {
    console.log(
      `FAIL  seznam ${LIST_FILE} neobsahuje jediný identifikátor.\n` +
        '        Prázdný seznam projde čímkoli, což je totéž jako žádná kontrola.\n' +
        `        Když seznam ještě nikdo nenaplnil, musí to říct direktivou ${UNPROVISIONED}.\n` +
        `        Provisioning: ${PROVISIONING}`,
    );
    return 1;
  }

  const scanned = scannedFiles();
  if (scanned.error) {
    console.log(`FAIL  ${scanned.error}`);
    return 1;
  }

  const { files, skipped, findings, blocked } = verdict(scanned.files, identifiers);

  // Identifikátor se nevypisuje. Skript se dá spustit i mimo lokální terminál
  // (`npm run gate:cleanroom`) a jeho výstup skončí v logu; tisknout do logu ta
  // jména by bylo totéž co commitnout seznam. Index do seznamu stačí na opravu —
  // ten seznam má u sebe každý, kdo tuhle bránu vůbec může spustit.
  for (const finding of findings) {
    console.log(`FAIL  ${finding.file}:${finding.line} nese zakázaný identifikátor č. ${finding.index + 1} ze seznamu`);
  }

  // Nepřečtený soubor je neznámý soubor. Dokud se počítal jen do varování, končil
  // běh nulou s větou „žádný nález" nad množinou, o které brána nic neví — a to je
  // ten tichý průchod, kterému se všude jinde v tomhle skriptu brání.
  if (skipped.length > 0) {
    console.log(
      `\nFAIL  ${skipped.length} souborů se nepodařilo přečíst a NEBYLY zkontrolované: ${skipped.slice(0, 3).join(', ')}`,
    );
  }

  if (unprovisioned && identifiers.length === 0) {
    // Fail-closed i tady. Nenaplněný seznam není měkčí stav než chybějící seznam:
    // hlídá stejné nic, jen u toho vypíše počet prohledaných souborů, takže výstup
    // vypadá jako práce. Kdo bránu potřebuje dočasně obejít, řekne to nahlas
    // proměnnou prostředí — hook ji nenastavuje.
    const waived = process.env[UNPROVISIONED_WAIVER] === '1';
    console.log(
      `\n${waived ? 'POZOR' : 'FAIL'}  seznam je označený jako nenaplněný (${UNPROVISIONED}) a nehlídá nic.\n` +
        '       Clean-room záruka je zatím PROCESNÍ, ne strojová, a nikde se nesmí\n' +
        `       tvrdit opak. Doplň identifikátory podle ${PROVISIONING}.\n` +
        (waived
          ? `       Průchod povolen proměnnou ${UNPROVISIONED_WAIVER}=1.`
          : `       Vědomé obejití: ${UNPROVISIONED_WAIVER}=1.`),
    );
    if (!waived) return 1;
  } else if (unprovisioned) {
    console.log(
      `\nPOZOR  seznam nese ${identifiers.length} identifikátorů, ale pořád je označený\n` +
        `       jako nenaplněný. Smaž řádek ${UNPROVISIONED}, jinak hlásí nepravdu.`,
    );
  }

  console.log(
    findings.length === 0
      ? `\n${files} souborů proti ${identifiers.length} identifikátorům — žádný nález.`
      : `\n${findings.length} nálezů v ${files} souborech.`,
  );
  return blocked ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { LIST_FILE, UNPROVISIONED, UNPROVISIONED_WAIVER, verdict };
