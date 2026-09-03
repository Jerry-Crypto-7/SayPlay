/**
 * **Sdílený svět: adresa, retence a to, že ho vypnutí zbytku nesmí zhasnout**
 * (P15 T30, design book §22.4 a §24).
 *
 * Tvrzení, kvůli kterému tenhle soubor existuje, je poslední popsané: **rozbitý
 * ovládací soubor a vypnuté placené dveře nechají hotové světy čitelné.** Je to
 * ta půlka kill switchů, kterou nikdo nevidí, dokud nepřijde incident — a
 * zároveň ta, u které se špatné rozhodnutí projeví tím, že demo zhasne celé.
 *
 * Čas se sem **vstřikuje**, nečte se `Date.now()`. Retence měřená skutečnými
 * hodinami je test, který buď trvá den, nebo netvrdí nic.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSessions, openSession, runGeneration } from '../../../../worldstream/sessions';
import {
  clearSharedWorlds,
  MAX_SHARED_WORLDS,
  readSharedWorld,
  SHARED_WORLD_TTL_MS,
  shareWorld,
  sharedWorldCount,
  sharedWorldHash,
} from '../../../../worldstream/snapshot-store';
import type { WorldstreamBlueprint } from '../../../../worldstream/schema';
import { GET as readSnapshot } from '../sessions/[sessionId]/route';
import { GET as readShared } from '../snapshots/[hash]/route';
import { PLAN, generated, grammar, scripted } from './world-fixture';

const temporary: string[] = [];

function controlFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-snapshot-'));
  temporary.push(dir);
  const path = join(dir, 'control.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

function switchOff(...names: string[]): void {
  vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: names })));
}

function get(hash: string): Promise<Response> {
  return readShared(new Request(`http://127.0.0.1/api/worldstream/snapshots/${hash}`), {
    params: Promise.resolve({ hash }),
  });
}

/**
 * Blueprint z fixtury, s vlastním titulkem, ať se dají odlišit dva světy.
 *
 * **Uklízí po sobě registr sdílených světů**, protože fixtura jede přes
 * `runGeneration`, a ta od T30 hotový svět sdílí sama. Bez toho by každé
 * zavolání téhle funkce přidalo do mapy jeden svět a tvrzení o počtu by měřila
 * fixtura, ne test. Test, který potřebuje dva světy naráz, si je proto vyrobí
 * oba dřív, než sdílí první z nich.
 */
async function world(title: string): Promise<WorldstreamBlueprint> {
  const stored = await generated();
  if (stored.blueprint === null) throw new Error('the fixture produced no blueprint');
  clearSharedWorlds();
  return { ...stored.blueprint, title };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearSharedWorlds();
  clearSessions();
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ *
 * Adresa.
 * ------------------------------------------------------------------ */

describe('adresa je otisk obsahu', () => {
  it('týž svět dá tutéž adresu, jiný svět jinou', async () => {
    const first = await world('a hall of frozen bells');
    const second = await world('a hall of frozen drums');
    expect(sharedWorldHash(first)).toBe(sharedWorldHash(first));
    expect(sharedWorldHash(first)).not.toBe(sharedWorldHash(second));
  });

  it('je dost dlouhá na to, aby se nedala vyjmenovat', async () => {
    // 32 hexadecimálních znaků, tedy 128 bitů. Osmiznakový `canonicalHash`
    // (FNV-1a) by tady byl adresní prostor, který se dá projít hrubou silou — a
    // sdílený svět je čitelný komukoli, kdo adresu zná.
    expect(sharedWorldHash(await world('a quiet observatory'))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sdílet dvakrát týž svět je jedno sdílení a lhůtu to neobnoví', async () => {
    const blueprint = await world('a tidal library');
    const hash = shareWorld(blueprint, 1_000);
    expect(shareWorld(blueprint, 500_000)).toBe(hash);
    expect(sharedWorldCount()).toBe(1);
    // Kdyby druhé sdílení přepsalo `publishedAtMs`, dal by se svět držet naživu
    // donekonečna tím, že se pořád dokola zakládá relace nad týmž promptem.
    expect(readSharedWorld(hash, 1_000 + SHARED_WORLD_TTL_MS)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Retence.
 * ------------------------------------------------------------------ */

describe('retence je explicitní, ne „navždy"', () => {
  it('svět po vypršení lhůty zmizí', async () => {
    const hash = shareWorld(await world('a sunken belfry'), 0);
    expect(readSharedWorld(hash, SHARED_WORLD_TTL_MS - 1)).not.toBeNull();
    expect(readSharedWorld(hash, SHARED_WORLD_TTL_MS)).toBeNull();
  });

  it('vypršelý svět se z paměti doopravdy uvolní, ne jen skryje', async () => {
    const first = await world('a hollow lighthouse');
    const second = await world('a second world');

    shareWorld(first, 0);
    expect(sharedWorldCount()).toBe(1);
    shareWorld(second, SHARED_WORLD_TTL_MS);
    expect(sharedWorldCount()).toBe(1);
  });

  it('drží se nejvýš `MAX_SHARED_WORLDS`, a sdílení se přesto nikdy neodmítne', async () => {
    const blueprint = await world('numbered');
    for (let i = 0; i <= MAX_SHARED_WORLDS; i += 1)
      shareWorld({ ...blueprint, title: `numbered ${i}` }, 1_000);
    expect(sharedWorldCount()).toBe(MAX_SHARED_WORLDS);
    // Nejnovější je ten, který musí zůstat: vyhazuje se odpředu, tedy nejstarší.
    expect(readSharedWorld(sharedWorldHash({ ...blueprint, title: 'numbered 0' }), 1_000)).toBeNull();
    expect(
      readSharedWorld(sharedWorldHash({ ...blueprint, title: `numbered ${MAX_SHARED_WORLDS}` }), 1_000),
    ).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Dveře.
 * ------------------------------------------------------------------ */

describe('dveře sdíleného světa', () => {
  it('vydají svět a dovolí ho cachovat navždy', async () => {
    const hash = shareWorld(await world('a cathedral of salt'), Date.now());
    const response = await get(hash);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const body = (await response.json()) as Record<string, unknown>;
    // Uzavřený seznam polí: nová položka v odpovědi je vědomé rozhodnutí, ne
    // něco, co se do veřejných dveří přilepí cestou.
    expect(Object.keys(body).sort()).toEqual(['blueprint', 'hash', 'sessionSeed', 'title']);
    expect(body.title).toBe('a cathedral of salt');
  });

  it('neznámá adresa dostane tutéž odpověď jako vypršelá', async () => {
    const missing = await get('0'.repeat(32));
    expect(missing.status).toBe(404);
    const code = ((await missing.json()) as { error: { code: string } }).error.code;

    const hash = shareWorld(await world('an expired world'), Date.now() - SHARED_WORLD_TTL_MS);
    const expired = await get(hash);
    expect(expired.status).toBe(404);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it('nebere od klienta nic než adresu — ani cestu, ani soubor', async () => {
    // Cesta místo otisku se nesmí stát čtením souboru. Odpověď je 404, ne obsah
    // a ne výjimka.
    for (const attempt of ['../../../etc/passwd', 'C:\\Windows\\win.ini', '..%2f..%2fsecret']) {
      const response = await get(attempt);
      expect(response.status).toBe(404);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Kill switche — to hlavní tvrzení.
 * ------------------------------------------------------------------ */

describe('vypnutí zbytku nechá hotové světy čitelné', () => {
  it('vypnutý upstream, relace i refine na sdílený svět nesahají', async () => {
    const hash = shareWorld(await world('a world that outlived the model'), Date.now());
    switchOff('upstream', 'sessions', 'refine');
    expect((await get(hash)).status).toBe(200);
  });

  it('rozbitý ovládací soubor taky ne — překlep v JSONu nesmí položit demo', async () => {
    const hash = shareWorld(await world('a world that outlived a typo'), Date.now());
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile('{ rozbito'));
    expect((await get(hash)).status).toBe(200);
  });

  it('`all` zhasne i tyhle dveře, protože to je „vypni provoz"', async () => {
    const hash = shareWorld(await world('a world switched off with everything'), Date.now());
    switchOff('all');
    const response = await get(hash);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SERVICE_DISABLED');
  });
});

/* ------------------------------------------------------------------ *
 * Producent — kdo ten svět vůbec sdílí.
 * ------------------------------------------------------------------ */

describe('hotový svět dostane adresu sám', () => {
  it('generace, která došla na konec, je čitelná pod svou adresou', async () => {
    const emitter = scripted();
    const stored = openSession('shared-happy', 4021);
    await runGeneration(stored, PLAN.intent.setting, { emit: emitter.emit, grammar: grammar() });

    expect(stored.session.phase).toBe('world');
    expect(stored.sharedWorld).not.toBeNull();
    expect((await get(stored.sharedWorld as string)).status).toBe(200);
  });

  it('generace, která skončila poruchou, žádnou adresu nedostane', async () => {
    const stored = openSession('shared-failed', 4021);
    await runGeneration(stored, PLAN.intent.setting, {
      emit: async () => ({ intent: 'a salt flat' }),
      grammar: grammar(),
    });

    expect(stored.session.phase).toBe('failed');
    expect(stored.sharedWorld).toBeNull();
    expect(sharedWorldCount()).toBe(0);
  });

  it('snapshot relace tu adresu vydá, jinak by ji nikdo nemohl předat dál', async () => {
    const emitter = scripted();
    const stored = openSession('shared-address', 4021);
    await runGeneration(stored, PLAN.intent.setting, { emit: emitter.emit, grammar: grammar() });

    const response = await readSnapshot(new Request('http://127.0.0.1/x'), {
      params: Promise.resolve({ sessionId: 'shared-address' }),
    });
    const body = (await response.json()) as { sharedWorld: string | null };
    expect(body.sharedWorld).toBe(`/api/worldstream/snapshots/${stored.sharedWorld}`);
  });
});
