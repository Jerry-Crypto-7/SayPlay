import {withSessionStorageResponse} from '@/server/session-persistence';
import {assertSessionStorageReady} from '@/worldstream/sessions';
/**
 * `GET /api/worldstream/sessions/:id` — autoritativní snapshot (P13 T16, §21).
 *
 * Je to **jediná odpověď na „co se stalo, než jsem se připojil"**. Protokol §20
 * je „snapshot plus události za posledním číslem", takže rámce se nikdy
 * nepřehrávají od nuly: log si historii nedrží a držet ji nemá — klient, který
 * přichází teď, dostane celý stav jedním kusem a od `sequence` navazuje.
 *
 * **Bez secrets.** Ven jde fáze, číslo proudu, stavy reprezentací, blueprint
 * a veřejná věta o poruše. Text výjimky poskytovatele ven nejde nikdy;
 * `runGeneration` ho odkládá do logu operátora a sem posílá `SESSION_FAULTS`.
 */

import { killState } from '@/server/kill-switch';

import { getSession } from '../../../../../worldstream/sessions';

export const runtime = 'nodejs';

async function handleDurableGET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  // **Čtení existujícího světa, tedy `snapshots` — táž třída jako
  // `/api/worldstream/snapshots/:hash` a stejná odpověď.** Jediný vypínač,
  // který na tyhle dveře sahá, je `all`: rozbitý ovládací soubor je nechává
  // běžet schválně, protože §22.4 chce, aby existující světy zůstaly čitelné.
  // Do `T28-killemit` je nečetl žádný, takže „vypni provoz" zastavil zakládání
  // i sesterský snapshot a autoritativní stav relace vydával dál.
  if ((await killState(process.env)).snapshots)
    return Response.json(
      { error: { code: 'SERVICE_DISABLED', message: 'this deployment is switched off right now' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );

  const { sessionId } = await context.params;
  const stored = getSession(sessionId);

  if (stored === null)
    return Response.json(
      {
        error: {
          code: 'UNKNOWN_SESSION',
          message: 'no session with that id is being served by this process',
        },
      },
      { status: 404 },
    );

  const snapshot = stored.session.snapshot();
  return Response.json(
    {
      sessionId: snapshot.sessionId,
      sessionSeed: snapshot.sessionSeed,
      phase: snapshot.phase,
      sequence: snapshot.sequence,
      representations: snapshot.representations,
      blueprint: stored.blueprint,
      visualPreview: stored.visualPreview ?? null,
      fault: stored.fault,
      generationMetrics: stored.generationMetrics?.snapshot() ?? null,
      recovery:stored.recovery??null,
      // Adresa hotového světa, nebo `null`. Je to jediné místo, kde se adresa
      // dozví prohlížeč té relace — a tím i jediný člověk, který ji smí předat
      // dál. Bez toho by sdílené světy měly adresu, kterou nikdo nezná.
      sharedWorld:
        stored.sharedWorld === null ? null : `/api/worldstream/snapshots/${stored.sharedWorld}`,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(...args:Parameters<typeof handleDurableGET>):Promise<Response> {
  return withSessionStorageResponse(async()=>{assertSessionStorageReady();return handleDurableGET(...args);});
}
