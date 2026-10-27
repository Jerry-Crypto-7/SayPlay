'use client';

import { Button } from '../ui';
import { useXrControls } from './xr-context';

/** „Enter VR“ (P65 T1): jen s `?vr=1` a prohlížečem, který VR umí (`XrGate`); v relaci z něj je „Exit VR“. */
export function EnterVrButton() {
  const xr = useXrControls();
  if (xr === null) return null;
  return xr.presenting ? (
    <Button variant="secondary" size="s" className="play-hud-vr" data-testid="exit-vr" onClick={xr.exit}>
      Exit VR
    </Button>
  ) : (
    <Button variant="secondary" size="s" className="play-hud-vr" data-testid="enter-vr" onClick={() => void xr.enter()}>
      Enter VR
    </Button>
  );
}
