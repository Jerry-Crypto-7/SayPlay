import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const frozenDir = join(repoRoot, 'evals', 'frozen');
const manifestPath = join(frozenDir, 'MANIFEST.lock');
const markerPath = join(frozenDir, 'FROZEN');
const anchorPath = join(repoRoot, 'evals', 'FROZEN_ANCHOR');

interface Manifest {
  algorithm: string;
  files: Record<string, string>;
}

interface Requirement {
  rid: string;
  layer: string;
  kind: string;
}

interface Contract {
  id: string;
  verdictCeiling: 'FULFILLED' | 'ROBUST';
  scoreAs?: 'FULFILLABLE' | 'ROBUST_ONLY';
  scoreAsReason?: string;
  requirements: Requirement[];
}

/**
 * `sceneMustBuild` platí pro každý prompt, který projde moderací (§13.4), takže
 * sám o sobě nic neodlišuje. Kontrakt, jehož jediný požadavek je tenhle, je
 * vakuózní — a musí to o sobě říct štítkem, ne mlčením.
 */
const NON_DISCRIMINATING_KINDS = new Set(['sceneMustBuild']);

/**
 * Hash se počítá nad obsahem normalizovaným na LF. Bez toho by tentýž soubor
 * dal na Windows jiný hash než na Linuxu a zmrazení by neznamenalo nic
 * ověřitelného. Repo to vynucuje i gitem (.gitattributes), tohle je druhá vrstva.
 */
function normalisedSha256(absolutePath: string): string {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

function frozenRelativePaths(): string[] {
  return listFilesRecursive(frozenDir)
    .map((abs) => relative(frozenDir, abs).split(sep).join(posix.sep))
    .sort();
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

/**
 * Commity, které kdy zapsaly marker, nejstarší první.
 *
 * `--full-history` je tu nosné, ne kosmetické: bez něj git u merge commitu
 * prořezává větve, které vypadají TREESAME, a celá vedlejší linie — včetně
 * commitů, které marker doopravdy zapsaly — z odpovědi zmizí.
 */
const markerCommits = git('log', '--full-history', '--reverse', '--format=%H', '--', 'evals/frozen/FROZEN')
  .split('\n')
  .filter(Boolean);
const freezeEverClosed = markerCommits.length > 0;

describe('evals/frozen — hash lock', () => {
  it('používá sha256', () => {
    expect(manifest.algorithm).toBe('sha256');
  });

  it('každý soubor v manifestu existuje a jeho hash sedí', () => {
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const abs = join(frozenDir, rel);
      expect(existsSync(abs), `chybí zmrazený soubor ${rel}`).toBe(true);
      expect(normalisedSha256(abs), `hash nesedí u ${rel}`).toBe(expected);
    }
  });

  // Bez téhle kontroly by šlo do zmrazeného adresáře nepozorovaně PŘIDAT obsah:
  // hash existujících souborů by dál seděl a lock by o novém souboru mlčel.
  it('manifest kryje každý soubor uvnitř evals/frozen/', () => {
    const onDisk = frozenRelativePaths().filter((rel) => rel !== 'MANIFEST.lock');
    const covered = Object.keys(manifest.files).sort();
    expect(onDisk).toEqual(covered);
  });
});

/**
 * **Most mezi bajty a historií — bez něj nedokazuje celý aparát níž nic o tom,
 * co testy doopravdy čtou.**
 *
 * Hash lock výš čte korpus z DISKU a `MANIFEST.lock` čte taky z disku. Obojí je
 * zapisovatelné, takže „přepiš korpus a přepočítej lock" projde zeleně — a to
 * **bez jediného git příkazu**, s bitově nedotčenou historií, tagy i kotvou.
 * Blok o historii níž zase dokazuje vlastnosti GIT OBJEKTŮ. Dokud ty dvě poloviny
 * nic nespojí, ověřuje každá něco jiného a útok prochází mezerou mezi nimi.
 * Commitnutý podvrh navíc stačilo odstranit jedním `git reset --soft HEAD~1`:
 * historie zpátky na místě, index i strom dál přepsané, sada zelená.
 *
 * Tenhle blok je ta spojka: **bajty na disku se musí rovnat bajtům v HEADu.**
 * Teprve tím řetěz drží celý — disk == HEAD == poslední generace v kotvě ==
 * anotovaný tag.
 *
 * Porovnává se OBSAH, ne `git status`: status jde umlčet `assume-unchanged`
 * i `skip-worktree`, kdežto `git show HEAD:<cesta>` čte objekt a o nastavení
 * indexu nic neví. Normalizace na LF je tatáž jako u `normalisedSha256`, takže
 * se neporovnává konec řádku, ale obsah.
 */
describe('evals/frozen — disk se rovná commitnutému stromu', () => {
  const headFrozenFiles = (() => {
    try {
      return git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'evals/frozen')
        .split('\n')
        .filter(Boolean)
        .map((path) => path.replace(/^evals\/frozen\//, ''))
        .sort();
    } catch {
      return [];
    }
  })();

  const headNormalisedSha256 = (repoRelative: string): string => {
    const raw = execFileSync('git', ['show', `HEAD:${repoRelative}`], { cwd: repoRoot, maxBuffer: 1 << 28 });
    const normalised = raw.toString('utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
  };

  // Bez tohohle by se dal celý blok odzbrojit smazáním zmrazeného stromu z HEADu:
  // prázdný seznam a všechny aserce níž projdou naprázdno.
  it('zmrazený strom je v HEADu vůbec přítomný', () => {
    if (!freezeEverClosed) return;
    expect(headFrozenFiles.length, 'freeze byl uzavřen, ale HEAD nenese evals/frozen').toBeGreaterThan(0);
  });

  // Chytá PŘIDANÝ i SMAZANÝ soubor v pracovním stromu — hash existujících by u obou dál seděl.
  it('množina souborů na disku se rovná té v HEADu', () => {
    if (!freezeEverClosed) return;
    expect(frozenRelativePaths(), 'obsah evals/frozen/ na disku neodpovídá commitnutému').toEqual(headFrozenFiles);
  });

  it('každý zmrazený soubor má na disku bajty svého commitnutého protějšku', () => {
    if (!freezeEverClosed) return;
    for (const rel of headFrozenFiles) {
      const abs = join(frozenDir, rel);
      expect(existsSync(abs), `${rel} je v HEADu, ale chybí na disku`).toBe(true);
      expect(
        normalisedSha256(abs),
        `${rel}: bajty na disku se liší od commitnutých — korpus je přepsaný v pracovním stromu`,
      ).toBe(headNormalisedSha256(`evals/frozen/${rel}`));
    }
  });

  // Kotva arms všechno níž, takže přepsaná kotva v pracovním stromu je tatáž
  // třída útoku jako přepsaný korpus. Při přemrazení je tahle aserce jeden
  // commit červená — a přesně to je ten hlasitý mezistav, který kotva popisuje.
  it('kotva má na disku bajty svého commitnutého protějšku', () => {
    if (!freezeEverClosed || !existsSync(anchorPath)) return;
    expect(normalisedSha256(anchorPath), 'FROZEN_ANCHOR je v pracovním stromu přepsaná').toBe(
      headNormalisedSha256('evals/FROZEN_ANCHOR'),
    );
  });
});

describe('evals/frozen — žádný kontrakt neprochází mlčením', () => {
  const contracts = readFileSync(join(frozenDir, 'contracts.v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Contract);

  const prompts = readFileSync(join(frozenDir, 'prompts.v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string });

  it('každý zmrazený prompt má právě jeden kontrakt', () => {
    expect(contracts.map((c) => c.id).sort()).toEqual(prompts.map((p) => p.id).sort());
  });

  // Tohle je ta kontrola, bez které by se zabetonovala nadhodnocující metrika:
  // 42 ze 116 promptů v evals/gold.jsonl má prázdný `required` a projde čímkoli.
  it('každý kontrakt deklaruje scoreAs', () => {
    for (const c of contracts) {
      expect(c.scoreAs, `${c.id} nemá scoreAs`).toBeDefined();
      expect(['FULFILLABLE', 'ROBUST_ONLY'], `${c.id} má neznámé scoreAs`).toContain(c.scoreAs);
    }
  });

  it('ROBUST_ONLY nese odůvodnění a FULFILLABLE nese skutečný požadavek', () => {
    for (const c of contracts) {
      if (c.scoreAs === 'ROBUST_ONLY') {
        expect((c.scoreAsReason ?? '').length, `${c.id} je ROBUST_ONLY bez odůvodnění`).toBeGreaterThan(0);
        continue;
      }
      const discriminating = c.requirements.filter((r) => !NON_DISCRIMINATING_KINDS.has(r.kind));
      expect(discriminating.length, `${c.id} je FULFILLABLE, ale nemá jediný odlišující požadavek`).toBeGreaterThan(0);
    }
  });

  it('scoreAs souhlasí s verdictCeiling', () => {
    for (const c of contracts) {
      expect(c.scoreAs === 'ROBUST_ONLY', `${c.id}: scoreAs a verdictCeiling si odporují`).toBe(
        c.verdictCeiling === 'ROBUST',
      );
    }
  });

  // T16 mutuje požadavky PO JEDNOM a čeká překlopení verdiktu. Bez jedinečného
  // rid se "poruš právě tenhle jeden" nedá strojově adresovat.
  it('každé rid je v celé sadě jedinečné', () => {
    const rids = contracts.flatMap((c) => c.requirements.map((r) => r.rid));
    expect(rids.length).toBe(new Set(rids).size);
  });
});

/**
 * Historická půlka AC — ta, kterou nejde splnit přepočítáním obsahu spolu
 * s lockem, protože historie commitů se nedá přepsat bez viditelné stopy.
 *
 * **Západka, a proč vypadá takhle.** v1 měl invariant „FROZEN přidal právě
 * jeden commit" (`--diff-filter=A` + `toHaveLength(1)`). Byl monotónní: jakmile
 * marker jednou vznikl, žádná pozdější změna korpusu ho už nemohla uspokojit,
 * ani dopředu. Přemrazení na v2 ten invariant porušilo ze své podstaty — druhé
 * zmrazení marker přepíše — a první náprava ho nahradila otázkou „zapsal marker
 * ten commit, na který ukazuje kotva?". **To byl krok zpátky a review to
 * doložilo scénářem:** kotva je obyčejný soubor mimo `MANIFEST.lock`, takže
 * commit Z přepíše korpus, lock i marker a commit Z+1 přepíše kotvu na sebe —
 * celá sada zelená, nikde stopa. Přesně to praní, kterému má zmrazení bránit,
 * a po Phase 4 by šlo o ladění metriky podle výsledků.
 *
 * Západka je proto zobecněná, ne zrušená: **seznam commitů, které kdy zapsaly
 * `evals/frozen/FROZEN`, se musí přesně a v pořadí rovnat seznamu `generations`
 * v kotvě, a každá generace musí mít ANOTOVANÝ tag na svém commitu se sedícím
 * tree hashem i hashem podstromu.** Přepsat korpus jde dál — ale jen tak, že se
 * nahlásí další generace a všechny předchozí tagy zůstanou na místě s pravdivými
 * hashi. Tiché přemrazení tím není nemožné, je nepřehlédnutelné; a víc než to
 * lokální repo bez remote nabídnout neumí, jak říká sám marker.
 *
 * **Čtyři díry, které v téhle západce našlo druhé kolo brány, a jak jsou zavřené.**
 * (1) `git log -- <cesta>` NENÍ „commity, které kdy zapsaly ten soubor" — je to
 * zjednodušená procházka od HEADu, která u merge commitu jde jen za prvním
 * TREESAME rodičem a druhou stranu odřízne. Šlo tedy podstrčit paralelní linii
 * s podvrženými markery, mergnout ji tak, aby vyhrála, a skutečné commity zmizely
 * oběma dotazům z očí. → `--full-history` na obou dotazech **plus** aserce, že
 * commit každé generace je předkem té následující a poslední je předkem HEADu;
 * paralelní linie tím spadne na předkovství.
 * (2) Jméno tagu se četlo Z KOTVY (`g.tag`), takže literál `evals-frozen-v1`
 * nebyl nikde vynucený a šlo si zvolit vlastní. → jméno je odvozené z čísla
 * generace, ne přečtené.
 * (3) **Z tagu se četl jen jeho TYP.** Všechny porovnávané hashe se odvozovaly
 * z `markerCommit`, takže tag nepřidával ŽÁDNÝ nezávislý důkaz — a věta v kotvě
 * o tom, že „anotované tagy drží kopii týchž hashů nezávisle", byla tím pádem
 * nepravdivá. Přitom obě anotace ty hashe doopravdy nesou. → čte se **tělo
 * anotace** a musí oba hashe obsahovat. Teprve tím je ta věta pravdivá.
 * (4) Všechny aserce visely na neprázdném `markerCommits`, takže existoval stav,
 * ve kterém celý blok projde prázdný. → prázdný řetěz při existující kotvě je
 * selhání, a mělký klon se odmítne rovnou, protože nad useknutou historií se
 * tohle ověřit NEDÁ a tichý průchod by lhal.
 */
describe('evals/frozen — historie po uzavření freeze', () => {
  interface Generation {
    generation: number;
    tag: string;
    markerCommit: string;
    treeHash: string;
    frozenSubtreeHash: string;
  }

  const anchorExists = existsSync(anchorPath);
  const anchor = anchorExists
    ? (JSON.parse(readFileSync(anchorPath, 'utf8')) as { generations?: Generation[] })
    : null;

  /** Je `a` předek `b` (nebo `b` sám)? */
  const isAncestor = (a: string, b: string): boolean => {
    if (a === b) return true;
    try {
      git('merge-base', '--is-ancestor', a, b);
      return true;
    } catch {
      return false;
    }
  };

  // Nad useknutou historií se řetěz ověřit NEDÁ. Tiše projít by znamenalo vydat
  // „nevím" za „v pořádku" — a to je přesně ta záměna, kterou má tenhle blok lovit.
  it('historie je úplná, jinak se tenhle blok nedá vyhodnotit', () => {
    expect(git('rev-parse', '--is-shallow-repository'), 'mělký klon — řetěz generací nejde ověřit').toBe('false');
  });

  // Autoritou je HISTORIE, ne přítomnost souboru. Původní znění gatovalo celý
  // blok na `existsSync(anchorPath)`, takže SMAZÁNÍ kotvy z něj udělalo no-op —
  // jeden commit „smaž kotvu + přepiš korpus + přepočítej lock" byl zelený.
  // Přemrazení v2 tou dírou samo prošlo; tohle ji zavírá.
  it('kotva existuje, jakmile historie ukazuje, že FROZEN kdy vznikl', () => {
    if (!freezeEverClosed) return;
    expect(anchorExists, 'FROZEN v historii je, ale kotva chybí — freeze byl odzbrojen').toBe(true);
  });

  it('marker FROZEN existuje, jakmile existuje kotva', () => {
    if (!anchorExists) return;
    expect(existsSync(markerPath), 'kotva existuje, ale marker FROZEN chybí — freeze byl rozmrazen').toBe(true);
  });

  // Bez tohohle by prázdný `generations` udělal ze všech asercí níž vakuum.
  it('kotva, která existuje, nahlašuje aspoň jednu generaci', () => {
    if (!anchorExists) return;
    expect((anchor?.generations ?? []).length, 'kotva existuje, ale nehlásí žádnou generaci').toBeGreaterThan(0);
  });

  it('řetěz generací se přesně kryje s commity, které kdy zapsaly FROZEN', () => {
    if (!freezeEverClosed) return;

    // Nerovnost tady znamená jedno ze dvou: buď se korpus přemrazil a nikdo to
    // nenahlásil, nebo někdo z řetězu vyškrtl generaci, aby zmizela její vada.
    expect(
      (anchor?.generations ?? []).map((g) => g.markerCommit),
      'seznam nahlášených generací nesouhlasí s commity, které zapsaly FROZEN',
    ).toEqual(markerCommits);
  });

  it('generace tvoří jednu linii, která končí u HEADu', () => {
    if (!freezeEverClosed) return;

    const generations = anchor?.generations ?? [];
    for (let i = 1; i < generations.length; i += 1) {
      expect(
        isAncestor(generations[i - 1].markerCommit, generations[i].markerCommit),
        `generace ${generations[i - 1].generation} není předkem generace ${generations[i].generation} — řetěz je slepený ze dvou linií`,
      ).toBe(true);
    }
    const newest = generations[generations.length - 1];
    if (!newest) return;
    expect(
      isAncestor(newest.markerCommit, git('rev-parse', 'HEAD')),
      'poslední generace neleží v historii HEADu',
    ).toBe(true);
  });

  it('každá generace má anotovaný tag pod svým jménem a se sedícími tree hashi', () => {
    if (!freezeEverClosed) return;

    for (const g of anchor?.generations ?? []) {
      // Jméno se ODVOZUJE z čísla generace. Kdyby se četlo z kotvy, mohl by si
      // ho podvrh zvolit a `evals-frozen-v1` by nikde vynucený nebyl.
      const name = `evals-frozen-v${g.generation}`;
      expect(g.tag, `generace ${g.generation} hlásí tag ${g.tag}`).toBe(name);
      // Lightweight tag by šlo přepsat bez stopy a anotace by neexistovala —
      // právě v ní je zapsaná vada té generace.
      expect(git('cat-file', '-t', name), `${name} není anotovaný tag`).toBe('tag');
      expect(git('rev-parse', `${name}^{commit}`), `${name} neukazuje na svůj markerový commit`).toBe(g.markerCommit);
      expect(git('rev-parse', `${g.markerCommit}^{tree}`), `${name}: tree hash nesedí`).toBe(g.treeHash);
      // Podvrh musí lhát na dvou místech, ne na jednom: tenhle hash kryje
      // výhradně zmrazený podstrom, takže ho nezakryje změna jinde v commitu.
      expect(git('rev-parse', `${g.markerCommit}:evals/frozen`), `${name}: hash podstromu nesedí`).toBe(
        g.frozenSubtreeHash,
      );

      // A tohle je ta NEZÁVISLÁ kopie. Bez čtení anotace přidával tag jen svůj
      // typ a věta v kotvě o nezávislém důkazu byla nepravdivá. Porovnává se
      // holý hash jako podřetězec, ne formát — v1 a v2 mají anotaci každý jinak.
      const annotation = git('cat-file', '-p', name);
      expect(annotation, `${name}: anotace nenese tree hash, tag tedy nic nedokládá`).toContain(g.treeHash);
      expect(annotation, `${name}: anotace nenese hash podstromu`).toContain(g.frozenSubtreeHash);
    }
  });

  it('po markeru poslední generace se do evals/frozen/ znovu nesáhlo', () => {
    if (!freezeEverClosed) return;

    const newest = markerCommits[markerCommits.length - 1];
    expect(
      git('log', '--full-history', '-1', '--format=%H', '--', 'evals/frozen'),
      'po markeru se do evals/frozen/ znovu sáhlo',
    ).toBe(newest);
  });
});
