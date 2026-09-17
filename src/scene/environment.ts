import type { IntentSummary } from '@/model/worldstream-intent';

/** Conservative scene lighting derived from explicit semantic description; no preset geometry. */
export function sceneEnvironment(intent: IntentSummary) {
  const description = `${intent.setting} ${intent.mood}`.toLowerCase();
  const night = /\b(night|nighttime|moonlit|nocturnal)\b/.test(description);
  const interior = /\b(room|interior|library|hall|cafe|café|reading|indoors)\b/.test(description);
  return { kind: interior ? 'interior' as const : 'exterior' as const, night,
    background: night ? '#14242e' : interior ? '#c3bba9' : '#b7d0d8',
    keyIntensity: night ? 0.7 : interior ? 1.65 : 2.1,
    hemisphereIntensity: night ? 0.24 : 0.65 };
}
export type SceneEnvironment = ReturnType<typeof sceneEnvironment>;
