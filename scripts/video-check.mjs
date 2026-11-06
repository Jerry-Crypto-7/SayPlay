#!/usr/bin/env node
/**
 * Brána nad scénářem videa: vejde se stopáž do tvrdého limitu a jsou v ní
 * všechny povinné scény?
 *
 * `RULES.md` §2 dává demo videu **tvrdý limit 3:00**. Přetažené video se
 * nedoodevzdá — přijde se na to až u střihu, kdy je natočeno a scénář se
 * přepisovat nedá. Tenhle skript se proto ptá na stopáž **dřív, než někdo
 * zapne nahrávání**.
 *
 * Skončí `0`, když je součet pod limitem a nechybí beat, jinak `1`; bez argumentu `2`.
 *
 * **Hotové video (P71A).** Cesta končící `.mp4` se nekontroluje jako scénář: délku čte
 * `ffprobe` (proměnná `FFPROBE`, jinak `ffprobe` z PATH) a velikost `statSync`. Chybějící
 * `ffprobe` je chyba s exit 1, ne tichý průchod – neověřená délka není délka pod limitem.
 *
 *   node scripts/video-check.mjs docs/video-script.md
 *   node scripts/video-check.mjs <video>.mp4
 *
 * Limit je **ostře pod** 3:00 pro scénář i soubor: video dlouhé přesně 180,0 s už limit nesplní.
 *
 * **Proč se sčítají úseky a ne čte poslední značka.** Poslední značka je jedno
 * číslo, které do scénáře napíše člověk — a když se úseky mezitím posunou,
 * zůstane stát a scénář vypadá krátký. Součet úseků se posune s nimi. Ta samá
 * úvaha zakazuje překryv: dva úseky přes sebe dají součet menší, než jak
 * dlouho video doopravdy poběží, takže **spojitost je podmínka, ne kosmetika**
 * — bez ní by šel limit obejít tím, že se značky napíšou nedbale.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** Tvrdý limit z `RULES.md` §2. Video musí být ostře kratší; 180,0 s už neprojde. */
export const LIMIT_SECONDS = 180;

/** Největší soubor videa k odevzdání: 100 MB (desítkově, ať je mez spíš přísnější). */
export const MAX_VIDEO_BYTES = 100_000_000;

const USAGE = 'použití: node scripts/video-check.mjs <scénář.md | video.mp4>';

/**
 * Délka videa v sekundách z `ffprobe`, nebo `{ error }` s čitelným důvodem: chybějící
 * program, nenulový exit, výstup, který není kladné číslo.
 */
export function ffprobeDuration(file, bin = process.env.FFPROBE || 'ffprobe') {
  const result = spawnSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  if (result.error !== undefined) {
    return { error: result.error.code === 'ENOENT' ? `ffprobe nenalezen (${bin}) – nainstaluj ffmpeg nebo nastav FFPROBE` : `ffprobe nejde spustit — ${result.error.message}` };
  }
  if (result.status !== 0) return { error: `ffprobe skončil ${String(result.status)}: ${String(result.stderr).trim().split('\n')[0]}` };
  const seconds = Number(String(result.stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return { error: `ffprobe nevrátil délku („${String(result.stdout).trim()}“)` };
  return { seconds };
}

/** Kontrola hotového MP4: velikost a délka ostře pod limitem. */
function checkVideo(file, { probe, sizeOf }) {
  let bytes;
  try {
    bytes = sizeOf(file);
  } catch (error) {
    console.log(`FAIL  ${file} nejde přečíst — ${error.message}`);
    return 1;
  }
  if (bytes > MAX_VIDEO_BYTES) {
    console.log(`FAIL  ${file}: ${(bytes / 1e6).toFixed(1)} MB, limit je ${MAX_VIDEO_BYTES / 1e6} MB`);
    return 1;
  }
  const { seconds, error } = probe(file);
  if (error !== undefined) {
    console.log(`FAIL  ${file}: délku nejde ověřit — ${error}`);
    return 1;
  }
  if (seconds >= LIMIT_SECONDS) {
    console.log(`FAIL  ${file}: ${seconds.toFixed(1)} s, video musí být kratší než ${formatTime(LIMIT_SECONDS)}`);
    return 1;
  }
  console.log(`PASS  ${file}: ${seconds.toFixed(1)} s, ${(bytes / 1e6).toFixed(1)} MB, pod limitem ${formatTime(LIMIT_SECONDS)} a ${MAX_VIDEO_BYTES / 1e6} MB.`);
  return 0;
}

/**
 * Scény, které scénář Sayplay musí obsáhnout: smyčka věta → hra → AI verze →
 * výzva → žebříček → remix a věta porotce mimo kategorii (`RULES.md` §3).
 * Identifikátor se hledá ve druhém sloupci tabulky, ne v próze: hledat českou
 * větu znamená, že přeformulování titulku tiše vypne kontrolu. Je to zároveň
 * jméno klipu, který natočí `e2e/demo-capture.spec.ts`.
 */
export const REQUIRED_BEATS = ['say-to-play', 'ai-version', 'dare-friend', 'leaderboard', 'remix', 'off-category'];

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

export function main(argv, { probe = (file) => ffprobeDuration(file), sizeOf = (file) => statSync(file).size } = {}) {
  const file = argv[0];
  if (file === undefined) {
    console.log(USAGE);
    return 2;
  }
  if (/\.mp4$/i.test(file)) return checkVideo(file, { probe, sizeOf });

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
  if (total >= LIMIT_SECONDS) {
    console.log(
      `FAIL  ${file}: stopáž ${formatTime(total)} nesplní limit, video musí být kratší než ${formatTime(LIMIT_SECONDS)}`,
    );
    return 1;
  }

  console.log(
    `PASS  ${file}: ${segments.length} úseků, stopáž ${formatTime(total)}, ` +
      `rezerva ${LIMIT_SECONDS - total} s pod limitem, všechny povinné scény přítomné.`,
  );
  return 0;
}

// Jméno souboru, ne `import.meta.url`: scény čte i `e2e/demo-capture.spec.ts` a Playwright
// tenhle soubor překládá do CommonJS, kde `import.meta` neexistuje.
if (process.argv[1] !== undefined && basename(process.argv[1]) === 'video-check.mjs') {
  process.exit(main(process.argv.slice(2)));
}
