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

import { getSession } from '../../../../../worldstream/sessions';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
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
      fault: stored.fault,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
