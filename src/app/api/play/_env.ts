/**
 * Vlastní panorama pro prostředí, které knihovna nezná (P29C T7).
 *
 * Služba `ops/env/server.py` generuje panorama na lokální kartě za klíčem
 * `X-Env-Key`. Klíč zůstává tady na serveru: prohlížeč se ptá na stav i na
 * soubory přes `GET /api/play/games/:id/env` a ta se ptá služby.
 *
 * **Bez vlastního stavu.** Služba drží jednu úlohu na prostředí
 * (`POST /panorama` s týmž prostředím vrátí tutéž úlohu, hotové bere z cache
 * na disku), takže route jen zopakuje `POST` a přečte úlohu – na serverless
 * není co ztratit mezi instancemi.
 *
 * Bez služby nebo po její chybě dostane hra nejbližší předpečené panorama
 * (`src/play/env/library.ts`, P30A T4) – tak hraje i nasazené demo s vypnutým
 * PC. Když žádné nesedí, zůstává knihovní panorama: nic odsud hru nezdrží ani
 * nerozbije.
 */

import { after } from 'next/server';

import { settingInLibrary } from '@/play/arcade/look/env';
import { nearestBaked } from '@/play/env/library';
import { killState } from '@/server/kill-switch';

/** Kolik smí trvat jeden dotaz na službu; déle = služba není. */
const SERVICE_TIMEOUT_MS = 3_000;

interface Service {
  readonly endpoint: string;
  readonly key: string;
}

function serviceFromEnv(env: NodeJS.ProcessEnv = process.env): Service | null {
  const endpoint = env.PLAY_ENV_ENDPOINT?.trim().replace(/\/+$/, '');
  const key = env.PLAY_ENV_KEY?.trim();
  return endpoint && key ? { endpoint, key } : null;
}

/** Služba, pokud je nastavená a páka `env` (nebo `all`) ji nevypnula. */
async function liveService(): Promise<Service | null> {
  const service = serviceFromEnv();
  if (service === null || (await killState(process.env)).env) return null;
  return service;
}

/**
 * Prostředí ve tvaru, který služba přijme (`^[a-z0-9][a-z0-9 ,'-]{0,79}$`):
 * malá písmena, ostatní znaky jako mezera, nejvýš 80 znaků. `null` = nic nezbylo.
 */
export function serviceSetting(setting: string): string | null {
  const text = setting
    .toLowerCase()
    .replace(/[^a-z0-9 ,'-]+/g, ' ')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return text === '' ? null : text;
}

/** Potřebuje hra vlastní panorama? Jen když knihovna prostředí nezná a zbyde co poslat. */
export function needsCustomEnv(setting: string): boolean {
  return !settingInLibrary(setting) && serviceSetting(setting) !== null;
}

async function call(service: Service, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${service.endpoint}${path}`, {
    ...init,
    headers: { ...init.headers, 'x-env-key': service.key },
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    cache: 'no-store',
  });
}

async function submit(service: Service, setting: string): Promise<string | null> {
  const response = await call(service, '/panorama', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setting }) });
  if (!response.ok) return null;
  const body = (await response.json()) as { jobId?: unknown };
  return typeof body.jobId === 'string' && /^[a-f0-9]{1,64}$/.test(body.jobId) ? body.jobId : null;
}

interface JobView {
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly id?: string;
  readonly file?: string;
  readonly low?: string;
  readonly horizon?: string;
}

const FILE_NAME = /^[a-z0-9-]+\.webp$/;
const HORIZON = /^#[0-9a-f]{6}$/i;

async function job(service: Service, setting: string): Promise<JobView | null> {
  const id = await submit(service, setting);
  if (id === null) return null;
  const response = await call(service, `/jobs/${id}`);
  if (!response.ok) return null;
  const view = (await response.json()) as JobView;
  if (view.status !== 'done') return { status: view.status };
  // Hotová úloha bez platných jmen souborů je porucha služby, ne panorama.
  if (typeof view.file !== 'string' || !FILE_NAME.test(view.file) || typeof view.low !== 'string' || !FILE_NAME.test(view.low)) return { status: 'failed' };
  return { status: 'done', id: view.id, file: view.file, low: view.low, horizon: typeof view.horizon === 'string' && HORIZON.test(view.horizon) ? view.horizon : undefined };
}

/**
 * Po publikaci hry: založ úlohu, ať panorama vzniká, zatímco hráč hraje.
 * Neblokuje – `after()` jako u upgradu, bez něj (test volá handler přímo)
 * doběhne sama. Chyba služby se jen zapíše.
 */
export function startCustomEnv(setting: string): void {
  const text = serviceSetting(setting);
  if (serviceFromEnv() === null || text === null || settingInLibrary(setting)) return;
  const work = liveService()
    .then((service) => (service === null ? undefined : submit(service, text)))
    .then(
      () => undefined,
      (error: unknown) => console.warn(`[play] env service refused "${text}": ${String(error)}`),
    );
  try {
    after(work);
  } catch {
    void work;
  }
}

export type CustomEnvState =
  | { readonly status: 'library' | 'unavailable' | 'pending' | 'failed' }
  /** `url`/`low` jen u předpečeného panoramatu (statický soubor); jinak soubory jdou route. */
  | { readonly status: 'ready'; readonly id: string; readonly horizon: string | null; readonly url?: string; readonly low?: string };

/** Nejbližší předpečené panorama, když služba není nebo selhala; žádné nesedí = `otherwise`. */
function bakedOr(setting: string, otherwise: CustomEnvState): CustomEnvState {
  const baked = nearestBaked(setting);
  return baked === null ? otherwise : { status: 'ready', id: `baked-${baked.id}`, horizon: baked.horizon, url: baked.url, low: baked.low };
}

/** Stav vlastního panoramatu pro prostředí hry. Chyba i ticho služby = předpečené, jinak `unavailable`. */
export async function customEnvState(setting: string): Promise<CustomEnvState> {
  const text = serviceSetting(setting);
  if (settingInLibrary(setting) || text === null) return { status: 'library' };
  try {
    const service = await liveService();
    if (service === null) return bakedOr(setting, { status: 'unavailable' });
    const view = await job(service, text);
    if (view === null) return bakedOr(setting, { status: 'unavailable' });
    if (view.status === 'failed') return bakedOr(setting, { status: 'failed' });
    if (view.status !== 'done') return { status: 'pending' };
    return { status: 'ready', id: `custom-${view.id ?? text.replace(/[^a-z0-9]+/g, '-')}`, horizon: view.horizon ?? null };
  } catch {
    return bakedOr(setting, { status: 'unavailable' });
  }
}

/** Soubor hotového panoramatu (`full` 2048×1024, `low` náhled) ze služby, nebo `null`. */
export async function customEnvFile(setting: string, size: 'full' | 'low'): Promise<Response | null> {
  const text = serviceSetting(setting);
  if (text === null || settingInLibrary(setting)) return null;
  try {
    const service = await liveService();
    if (service === null) return null;
    const view = await job(service, text);
    const name = size === 'full' ? view?.file : view?.low;
    if (view?.status !== 'done' || name === undefined) return null;
    const file = await call(service, `/files/${name}`);
    if (!file.ok || file.body === null) return null;
    return new Response(file.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400' } });
  } catch {
    return null;
  }
}
