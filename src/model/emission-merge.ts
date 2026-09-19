/**
 * **Slepení odpovědí z několika kusů do jedné odpovědi kompilátoru.**
 *
 * Dnes píše kompilátor celý svět jednou odpovědí a medián toho psaní je 103 s
 * (naměřeno 13. 9. 2026). Rozřezat ho na kusy, které běží souběžně, má smysl
 * jen tehdy, když se dají slepit zpátky **beze ztráty a bez hádání**. Tenhle
 * modul je to slepení a zároveň jeho brána.
 *
 * ## Proč se řeže po top-level polích, ne po řádcích geometrie
 *
 * Uzly geometrie jsou adresované **pořadím** — placement ukazuje na
 * `{kind:"geom", node: 7}`. Kdyby dva kusy psaly vlastní pole uzlů, slepení by
 * muselo všechna ta čísla přečíslovat, a jakékoli přečíslování mění pořadí
 * uzlů, tedy i výsledný blueprint. „Týž blueprint jako z jednoho volání" by
 * pak byla nepravda hned v prvním případě.
 *
 * Řez proto vede tam, kde žádné odkazy nekříží: každý kus píše **jiná
 * top-level pole**.
 *
 * | Kus | Co píše | Co z toho čte jiný kus |
 * |---|---|---|
 * | `architecture` | `architecture`, `geometry` | indexy uzlů, na které míří placements |
 * | `objects` | `shapes`, `placements` | jména tvarů |
 * | `rules` | `world` | identity ze společného rejstříku |
 *
 * Kusy tedy nesdílejí text, ale **sdílejí rejstřík plánovače** — a právě to je
 * ten předpoklad, o kterém plán P21 říká, že ho má změřit. Jediná vazba přes
 * hranici kusu je `placements → geometry.nodes[i]`, a tu tady kontrolujeme.
 *
 * ## Co se odmítá a proč pojmenovaně
 *
 * Tiché přepsání je tady ten nejhorší možný výsledek: slepený svět, kde si dva
 * kusy odporují v identitě, vypadá na první pohled hotově a pozná se až tím,
 * že v něm něco chybí. Každý rozpor proto končí `MergeRejection` se jménem,
 * ne posledním zápisem.
 */

/** Kusy, na které se kompilátorový požadavek řeže na tři. Pořadí je pořadí slepení. */
export const EMISSION_CHUNKS = ['architecture', 'objects', 'rules'] as const;

/**
 * Řez na **dva** kusy (P22 T16): `scene` píše všechno prostorové naráz —
 * architekturu i objekty — takže jediná vazba přes hranici kusu
 * (`placements → geometry.nodes[i]`) zůstává uvnitř jednoho požadavku;
 * `rules` je týž kus jako u tří. Který řez se použije, rozhoduje volající
 * (`compileWithRepair.chunked`), ne tenhle modul.
 */
export const EMISSION_CHUNKS_TWO = ['scene', 'rules'] as const;

export type ChunkName = (typeof EMISSION_CHUNKS)[number] | (typeof EMISSION_CHUNKS_TWO)[number];

/** Všechny kusy, které umí požadavek nést. `scene` napřed, aby slepení dvou kusů drželo pořadí polí jako u tří. */
const ALL_CHUNKS: readonly ChunkName[] = ['scene', ...EMISSION_CHUNKS];

export function emissionChunks(pieces: 2 | 3): readonly ChunkName[] {
  return pieces === 2 ? EMISSION_CHUNKS_TWO : EMISSION_CHUNKS;
}

/** Která top-level pole smí který kus napsat. Nic mimo tenhle seznam neprojde. */
export const CHUNK_FIELDS: Readonly<Record<ChunkName, readonly string[]>> = {
  architecture: ['geometry', 'architecture'],
  objects: ['shapes', 'placements'],
  // Vazby vzhledu čtou proměnné ze `world.sim`, takže je píše tentýž kus.
  rules: ['world', 'lookBindings'],
  // Dvoukusý řez: pořadí polí je totéž jako architecture + objects za sebou.
  scene: ['geometry', 'architecture', 'shapes', 'placements'],
};

export type MergeRejection =
  /** Kus napsal pole, které mu nepatří — dva kusy by si přepsaly práci. */
  | 'FIELD_NOT_IN_CHUNK'
  /** Dva kusy napsaly totéž pole. */
  | 'FIELD_WRITTEN_TWICE'
  /** Kus vůbec nepřišel, nebo není objekt. */
  | 'CHUNK_MISSING'
  /** Týž `stableId` si nárokují dva různé zápisy. */
  | 'IDENTITY_CONFLICT'
  /** Placement míří na uzel geometrie, který v slepené odpovědi není. */
  | 'DANGLING_GEOM_NODE'
  /** Placement míří na tvar, který žádný kus nenapsal. */
  | 'DANGLING_SHAPE';

export interface MergeFailure {
  readonly ok: false;
  readonly reason: MergeRejection;
  readonly detail: string;
}

export interface MergeSuccess {
  readonly ok: true;
  /** Odpověď v přesně tom tvaru, jaký čeká `compileBlueprint`. */
  readonly answer: Record<string, unknown>;
}

export type MergeResult = MergeSuccess | MergeFailure;

/** Jeden došlý kus: co si o něj řeklo a co přišlo. */
export interface ChunkAnswer {
  readonly chunk: ChunkName;
  readonly answer: unknown;
}

function reject(reason: MergeRejection, detail: string): MergeFailure {
  return { ok: false, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `stableId` toho zápisu, pokud nějaký nese. */
function identityOf(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.stableId === 'string' ? entry.stableId : null;
}

/**
 * Slepí kusy do jedné odpovědi.
 *
 * Pole se **spojují, nepřepisují**: dva zápisy téhož pole jsou rozpor, ne
 * novější verze. Pořadí polí v návratu je pořadí kusů, takže slepení je
 * deterministické a dvě stejné sady kusů dají tentýž objekt.
 */
export function mergeEmissionChunks(chunks: readonly ChunkAnswer[]): MergeResult {
  const answer: Record<string, unknown> = {};
  const writtenBy = new Map<string, ChunkName>();

  for (const name of ALL_CHUNKS) {
    const arrived = chunks.filter((entry) => entry.chunk === name);
    if (arrived.length === 0) continue;

    for (const entry of arrived) {
      if (!isRecord(entry.answer))
        return reject('CHUNK_MISSING', `chunk ${name} did not answer with a JSON object`);

      for (const [field, value] of Object.entries(entry.answer)) {
        if (!CHUNK_FIELDS[name].includes(field))
          return reject(
            'FIELD_NOT_IN_CHUNK',
            `chunk ${name} wrote ${field}, which belongs to ${describeOwner(field)}`,
          );

        const earlier = writtenBy.get(field);
        if (earlier !== undefined)
          return reject('FIELD_WRITTEN_TWICE', `${field} was written by both ${earlier} and ${name}`);

        writtenBy.set(field, name);
        answer[field] = value;
      }
    }
  }

  const conflict = identityConflict(answer);
  if (conflict !== null) return reject('IDENTITY_CONFLICT', conflict);

  const dangling = danglingReference(answer);
  if (dangling !== null) return reject(dangling.reason, dangling.detail);

  return { ok: true, answer };
}

/** Komu to pole patří — do hlášky, aby se nehádalo z kódu. */
function describeOwner(field: string): string {
  const owner = EMISSION_CHUNKS.find((name) => CHUNK_FIELDS[name].includes(field));
  return owner ?? 'no chunk at all';
}

/**
 * Nárokují si dva zápisy touž identitu?
 *
 * Kontroluje se uvnitř `placements`, `shapes` i mezi nimi navzájem — tvar
 * a umístění se na `stableId` potkávají a dvojí zápis jednoho jména znamená,
 * že se jeden z nich při stavbě ztratí.
 */
function identityConflict(answer: Record<string, unknown>): string | null {
  for (const field of ['placements', 'shapes']) {
    const list = answer[field];
    if (!Array.isArray(list)) continue;

    const seen = new Set<string>();
    for (const entry of list) {
      const id = identityOf(entry);
      if (id === null) continue;
      if (seen.has(id)) return `${field} carries ${id} twice`;
      seen.add(id);
    }
  }
  return null;
}

/** Odkaz přes hranici kusu, který v slepené odpovědi nemá cíl. */
function danglingReference(
  answer: Record<string, unknown>,
): { reason: MergeRejection; detail: string } | null {
  const placements = answer.placements;
  if (!Array.isArray(placements)) return null;

  const geometry = answer.geometry;
  const nodes = isRecord(geometry) && Array.isArray(geometry.nodes) ? geometry.nodes.length : 0;
  const shapes = new Set(
    (Array.isArray(answer.shapes) ? answer.shapes : [])
      .map((shape: unknown) => (isRecord(shape) && typeof shape.shapeId === 'string' ? shape.shapeId : null))
      .filter((id): id is string => id !== null),
  );

  for (const entry of placements) {
    if (!isRecord(entry) || !isRecord(entry.source)) continue;
    const source = entry.source;
    const id = identityOf(entry) ?? 'an unnamed placement';

    if (source.kind === 'geom') {
      // Tohle je jediná vazba, která vede z jednoho kusu do druhého — placement
      // psal kus `objects`, uzly kus `architecture`.
      if (typeof source.node !== 'number' || source.node < 0 || source.node >= nodes)
        return {
          reason: 'DANGLING_GEOM_NODE',
          detail: `${id} points at geometry node ${String(source.node)}, but the merged geometry has ${String(nodes)}`,
        };
    }

    if (source.kind === 'shape' && typeof source.shapeId === 'string' && !shapes.has(source.shapeId))
      return {
        reason: 'DANGLING_SHAPE',
        detail: `${id} sources from shape ${source.shapeId}, which no chunk wrote`,
      };
  }

  return null;
}

/**
 * Rozřeže hotovou odpověď na kusy — **jen pro měření nad archivem**.
 *
 * Živá cesta kusy nikdy neskládá z hotové odpovědi; tohle je nástroj, kterým
 * se ptáme archivu, jestli by slepení dalo týž blueprint. Kdyby tahle funkce
 * bydlela v testu, nešlo by ji pustit nad archivem v měřicím souboru.
 */
export function splitAnswerIntoChunks(answer: Record<string, unknown>): ChunkAnswer[] {
  return EMISSION_CHUNKS.map((chunk) => {
    const part: Record<string, unknown> = {};
    for (const field of CHUNK_FIELDS[chunk]) if (field in answer) part[field] = answer[field];
    return { chunk, answer: part };
  }).filter((entry) => Object.keys(entry.answer as Record<string, unknown>).length > 0);
}
