import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';

/**
 * P16 T2 – jak dopadl jeden případ varianta × věta.
 *
 * `swap` je jediný úspěch: objevila se značka živého světa. Tiché selhání
 * dějství II na plátně vypadá jako úspěch – připravený svět zůstane a hláška
 * „writing" jen zmizí – proto má vlastní třídu a nikdy se nepočítá jako výměna.
 */
export type Outcome = 'swap' | 'silent-fail' | 'timeout' | 'no-start';

/** Co spec na stránce viděl od odeslání do rozhodnutí. */
export interface Observation {
  /** Objevilo se `second-act-writing`. */
  readonly sawWriting: boolean;
  /** `second-act-writing` zase zmizelo. */
  readonly writingGone: boolean;
  /** Objevilo se `world-live-origin`. */
  readonly sawLive: boolean;
}

export function classifyOutcome(observation: Observation): Outcome {
  // Živý svět rozhoduje sám: když model napsal už první větu, dějství II se
  // nespustí a hláška „writing" se neukáže vůbec.
  if (observation.sawLive) return 'swap';
  if (!observation.sawWriting) return 'no-start';
  return observation.writingGone ? 'silent-fail' : 'timeout';
}

export interface OutcomeRecord {
  readonly variant: string;
  readonly model: string;
  readonly effort: string | null;
  readonly id: string;
  readonly outcome: Outcome;
  readonly ms: number;
  readonly photo: string;
  readonly submitted: string;
}

interface ResultsFile { readonly records: readonly OutcomeRecord[] }

function read(file: string): ResultsFile {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ResultsFile) : { records: [] };
}

export function hasOutcome(file: string, variant: string, id: string): boolean {
  return read(file).records.some((record) => record.variant === variant && record.id === id);
}

/**
 * Dva workery zapisují do téhož souboru, takže čtení a zápis drží zámek –
 * adresář, protože `mkdir` je atomický i na Windows.
 */
export function recordOutcome(file: string, record: OutcomeRecord): void {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (attempt > 200) throw new Error(`${lock} is held – remove it if no run is writing`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const records = read(file).records.filter((kept) => !(kept.variant === record.variant && kept.id === record.id));
    writeFileSync(file, `${JSON.stringify({ records: [...records, record] }, null, 2)}\n`);
  } finally {
    rmdirSync(lock);
  }
}
