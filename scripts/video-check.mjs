#!/usr/bin/env node
/**
 * Brána nad scénářem videa: vejde se stopáž do tvrdého limitu a jsou v ní
 * všechny čtyři povinné beaty?
 *
 * `RULES.md` §2 dává demo videu **tvrdý limit 3:00**. Přetažené video se
 * nedoodevzdá — přijde se na to až u střihu, kdy je natočeno a scénář se
 * přepisovat nedá. Tenhle skript se proto ptá na stopáž **dřív, než někdo
 * zapne nahrávání**.
 *
 * Skončí `0`, když je součet pod limitem a nechybí beat, jinak `1`.
 *
 * **Proč se sčítají úseky a ne čte poslední značka.** Poslední značka je jedno
 * číslo, které do scénáře napíše člověk — a když se úseky mezitím posunou,
 * zůstane stát a scénář vypadá krátký. Součet úseků se posune s nimi. Ta samá
 * úvaha zakazuje překryv: dva úseky přes sebe dají součet menší, než jak
 * dlouho video doopravdy poběží, takže **spojitost je podmínka, ne kosmetika**
 * — bez ní by šel limit obejít tím, že se značky napíšou nedbale.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Tvrdý limit z `RULES.md` §2. Nad ním se video nedá odevzdat. */
export const LIMIT_SECONDS = 180;

/**
 * Beaty, které scénář musí obsáhnout. Jsou to čtyři vlastnosti, které porotce
 * jinak nemá jak uvidět — ne kapitoly. Identifikátor se hledá ve sloupci
 * `Beat`, ne v próze: hledat českou větu znamená, že přeformulování titulku
 * tiše vypne kontrolu.
 */
export const REQUIRED_BEATS = ['world-builds', 'rule-rewind', 'offline', 'winning-path'];

const TIME = String.raw`(\d{1,2}):([0-5]\d)`;
const ROW = new RegExp(String.raw`^\|\s*${TIME}\s*[–-]\s*${TIME}\s*\|\s*\x60([a-z-]+)\x60\s*\|`);

/** Sekundy z `m:ss`; `null`, když to není čas. */
export function parseTime(text) {
  const match = new RegExp(`^${TIME}$`).exec(String(text).trim());
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Úseky z tabulky scénáře. Řádky bez časového rozsahu se přeskočí — hlavička,
 * oddělovač i běžná próza kolem tabulky.
 */
export function parseSegments(markdown) {
  const segments = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (match === null) continue;
    segments.push({
      start: Number(match[1]) * 60 + Number(match[2]),
      end: Number(match[3]) * 60 + Number(match[4]),
      beat: match[5],
    });
  }
  return segments;
}

/** Součet délek úseků v sekundách. */
export function totalSeconds(segments) {
  return segments.reduce((sum, { start, end }) => sum + (end - start), 0);
}

/**
 * Důvod, proč úseky nejsou spojitá časová osa; `null`, když jsou.
 *
 * Kontroluje se i to, že úsek neběží pozpátku — `0:40–0:20` má zápornou délku
 * a jediné, co dělá, je že zkracuje součet.
 */
export function contiguityError(segments) {
  if (segments.length === 0) return 'scénář nemá jediný časový úsek';
  if (segments[0].start !== 0) return `první úsek začíná v ${segments[0].start} s, ne v nule`;
  for (const [index, segment] of segments.entries()) {
    if (segment.end <= segment.start) {
      return `úsek ${index + 1} (${segment.beat}) končí dřív, než začal`;
    }
    const previous = segments[index - 1];
    if (previous !== undefined && segment.start !== previous.end) {
      return `mezi úsekem ${index} a ${index + 1} je díra nebo překryv (${previous.end} s → ${segment.start} s)`;
    }
  }
  return null;
}

/** Povinné beaty, které se ve sloupci `Beat` neobjevily. */
export function missingBeats(segments) {
  const present = new Set(segments.map(({ beat }) => beat));
  return REQUIRED_BEATS.filter((beat) => !present.has(beat));
}

/** `m:ss` ze sekund — pro hlášení, ať se dá porovnat se scénářem. */
export function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function main(argv) {
  const file = argv[0];
  if (file === undefined) {
    console.log('FAIL  chybí argument: node scripts/video-check.mjs <scénář.md>');
    return 1;
  }

  let markdown;
  try {
    markdown = readFileSync(file, 'utf-8');
  } catch (error) {
    console.log(`FAIL  ${file} nejde přečíst — ${error.message}`);
    return 1;
  }

  const segments = parseSegments(markdown);
  const broken = contiguityError(segments);
  if (broken !== null) {
    console.log(`FAIL  ${file}: ${broken}`);
    return 1;
  }

  const missing = missingBeats(segments);
  if (missing.length > 0) {
    console.log(`FAIL  ${file}: chybí povinné beaty — ${missing.join(', ')}`);
    return 1;
  }

  const total = totalSeconds(segments);
  if (total > LIMIT_SECONDS) {
    console.log(
      `FAIL  ${file}: stopáž ${formatTime(total)} přetahuje tvrdý limit ${formatTime(LIMIT_SECONDS)} o ${total - LIMIT_SECONDS} s`,
    );
    return 1;
  }

  console.log(
    `PASS  ${file}: ${segments.length} úseků, stopáž ${formatTime(total)}, ` +
      `rezerva ${LIMIT_SECONDS - total} s pod limitem, všechny čtyři beaty přítomné.`,
  );
  return 0;
}

// `pathToFileURL`, ne ruční `file://` — na Windows je `process.argv[1]` cesta
// s `D:\`, kterou by ruční složení URL zakódovalo jinak než `import.meta.url`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
