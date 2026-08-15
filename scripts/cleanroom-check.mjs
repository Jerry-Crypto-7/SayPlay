#!/usr/bin/env node
/**
 * Clean-room kontrola: neobjevil se v repu identifikátor z proprietárního modulu?
 *
 * `DESIGN-BOOK.md` §12 o `VR-Builder-for-Games`: *„Jen doktrína, clean-room.
 * 8 353 řádků ECA modulu pod proprietární licencí AcmeCorp. Hodnota je v tom,
 * který výběr událostí, podmínek a akcí se osvědčil u neprogramátorů — ne v
 * názvech."* Repozitář půjde ven jako veřejný, takže přenesený název není
 * licenční detail — je to diskvalifikace a firemní problém zároveň.
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
 * Obejít se to dá — kdo seznam vyprázdní a dopíše tuhle direktivu, dostane
 * zelenou. Je to vědomý, viditelný zápis do souboru a hlásí se na každém běhu;
 * proti záměru tahle brána neobstojí tak jako tak (viz hlavička).
 */
const UNPROVISIONED = '#!unprovisioned';

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
  for (const identifier of identifiers) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`);
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) hits.push({ identifier, line: index + 1 });
    }
  }
  return hits;
}

/**
 * Skenují se **soubory, které jsou v repu nebo do něj můžou vstoupit** — tedy
 * trackované plus untrackované neignorované (`git ls-files -c -o
 * --exclude-standard`). Ne celý pracovní strom, a to ze dvou důvodů:
 *
 * 1. **Ignorované soubory tuhle bránu zajímat nesmějí.** `SECURITY-FINDINGS.md`
 *    je firemní dokument AcmeCorp a klidně může nést jméno z ECA modulu. Při
 *    skenu celého stromu by hlásil nález při každém commitu — a jediná cesta k
 *    zelené by bylo ten soubor smazat nebo bránu vypnout. Commitnout se stejně
 *    nedá, takže hlídat ho není k čemu.
 * 2. Sken celého stromu je řádově dražší a `pre-commit` běží při každém commitu.
 *
 * `--no-replace-objects` ze stejného důvodu jako v `blind-check.mjs`: `git
 * replace` umí podstrčit jiné bajty pod nezměněné OID.
 */
function scannedFiles() {
  let listing;
  try {
    listing = execFileSync('git', ['--no-replace-objects', 'ls-files', '-c', '-o', '--exclude-standard', '-z'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Fail-closed i tady: bez seznamu souborů kontrola neví, co skenovala, a
    // tichý průchod nad prázdnou množinou by vypadal jako čistý strom.
    return { error: `git ls-files selhal (${error.message.split('\n')[0]}) — bez seznamu souborů se nedá skenovat` };
  }

  const files = [];
  for (const shown of listing.split('\0')) {
    if (!shown || BINARY.test(shown)) continue;
    // Seznam sám ty identifikátory nese z definice. Kdyby se skenoval, hlásil
    // by nález na každém spuštění a jediná cesta k zelené by bylo ho vyprázdnit.
    if (shown === LIST_FILE) continue;
    files.push({ path: join(REPO, shown), shown });
  }
  return { files };
}

export function main(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'cleanroom-check — hlídá identifikátory z proprietárního ECA modulu',
        '',
        '  node scripts/cleanroom-check.mjs',
        '',
        'JE TO LEXIKÁLNÍ SHODA PROTI SEZNAMU JMEN, ne měření podobnosti obsahu.',
        'Hledá celá slova ze seznamu v pracovním stromě. Přepsaný kód se stejnou',
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

  console.log('cleanroom-check — DESIGN-BOOK.md §12, lexikální shoda proti seznamu jmen\n');

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

  let files = 0;
  const findings = [];
  for (const file of scanned.files) {
    let text;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    files += 1;
    for (const hit of findHits(text, identifiers)) findings.push({ ...hit, file: file.shown });
  }

  for (const finding of findings) {
    console.log(`FAIL  ${finding.file}:${finding.line} nese zakázaný identifikátor "${finding.identifier}"`);
  }

  if (unprovisioned && identifiers.length === 0) {
    console.log(
      `\nPOZOR  seznam je označený jako nenaplněný (${UNPROVISIONED}) a nehlídá nic.\n` +
        '       Clean-room záruka je zatím PROCESNÍ, ne strojová, a nikde se nesmí\n' +
        `       tvrdit opak. Doplň identifikátory podle ${PROVISIONING}.`,
    );
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
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { LIST_FILE, UNPROVISIONED };
