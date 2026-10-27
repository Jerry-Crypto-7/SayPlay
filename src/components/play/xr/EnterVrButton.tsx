'use client';

import { Button } from '../ui';
import { useXrControls } from './xr-context';

/**
 * „Enter VR“ (P65 T1) v HUD hry: jen s `?vr=1` a prohlížečem, který VR umí (`XrGate`), a mimo relaci. DOM v relaci
 * vidět není (Quest ho nekreslí, emulátor ho překryje plátnem brýlí), proto ven vede systémové tlačítko brýlí
 * a 3D panel „Exit VR“ (T5), ne tlačítko tady.
 */
export function EnterVrButton() {
  const xr = useXrControls();
  if (xr === null || xr.presenting) return null;
  return (
    <Button variant="secondary" size="s" className="play-hud-vr" data-testid="enter-vr" onClick={() => void xr.enter()}>
      Enter VR
    </Button>
  );
}
