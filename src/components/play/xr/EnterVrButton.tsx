'use client';

'use client';

import { Button } from '../ui';
import { useXrControls } from './xr-context';

/**
 * „Enter VR“ (P65 T1) v HUD hry: jen s prohlížečem, který VR umí (`XrGate`, P67 T1), mimo relaci a až když
 * ji klepnutí opravdu začne (`ready`). DOM v relaci vidět není (Quest ho nekreslí, emulátor ho překryje plátnem
 * brýlí), proto ven vede systémové tlačítko brýlí a 3D panel „Exit VR“ (T5), ne tlačítko tady.
 * `lobby` (P67 T2, domov `/play`): relace začne VR lobby s kartami vět, ne hrou z feedu.
 */
export function EnterVrButton({ lobby = false }: { readonly lobby?: boolean }) {
  const xr = useXrControls();
  if (xr === null || xr.presenting || !xr.ready) return null;
  return (
    <Button variant="secondary" size="s" className="play-hud-vr" data-testid="enter-vr" onClick={() => void xr.enter({ lobby })}>
      Enter VR
    </Button>
  );
}
