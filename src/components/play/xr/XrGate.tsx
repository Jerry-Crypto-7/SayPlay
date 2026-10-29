'use client';

/**
 * Brána VR pro celé `/play` (P65 T1), v layoutu, takže přežije navigaci z rychlé hry na AI verzi. S prohlížečem,
 * který umí `immersive-vr`, a bez `?vr=0` v adrese (P67 T1) načte `XrRoot` a dá hrám trvalé plátno XR relace.
 * Jinak jen předá děti s prázdným kontextem: stejný strom jako dřív a žádný bajt XR.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { xrGateOpen } from '@/play/xr/flag';

import { type XrControls, XrControlsContext, XrHostContext } from './xr-context';

type XrModule = typeof import('./XrRoot');

export function XrGate({ children }: { readonly children: ReactNode }) {
  const [xr, setXr] = useState<XrModule | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!(await xrGateOpen(window.location.href))) return;
      const module = await import('./XrRoot');
      if (live) setXr(module);
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => (xr === null ? undefined : xr.onPresenting(setPresenting)), [xr]);
  useEffect(() => (xr === null ? undefined : xr.onReady(setReady)), [xr]);
  const controls = useMemo<XrControls | null>(() => (xr === null ? null : { presenting, ready, enter: xr.enterVr, exit: xr.exitVr }), [xr, presenting, ready]);
  return (
    <XrHostContext.Provider value={xr?.host ?? null}>
      <XrControlsContext.Provider value={controls}>
        {xr !== null && <xr.XrStage />}
        {children}
      </XrControlsContext.Provider>
    </XrHostContext.Provider>
  );
}
