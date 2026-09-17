import { LOD_POLICY } from './visibility';
/**
 * Prahy streamovacích zón. **Runtime kopie `data/profiles/web-viewer.json`**;
 * profil je zdroj čísel a `src/scene/__tests__/viewer-profile.test.ts` jde
 * červeně, jakmile se rozejdou.
 */
export const ZONE_STREAM_POLICY={cellSize:24,retainDistance:48,resumeDistance:36,hiddenSeconds:5,intervalSeconds:0.25} as const;
export function zoneKey(point:readonly number[]):string {
  return `${Math.floor(point[0]/ZONE_STREAM_POLICY.cellSize)}:${Math.floor(point[2]/ZONE_STREAM_POLICY.cellSize)}`;
}
/** Presentation clock only. No world state, semantic IDs or runtime ticks are modified. */
export function createZoneTracker() {
  const hiddenSince=new Map<string,number>();
  return {
    /**
     * Zůstat, uspat, probudit — podle vzdálenosti, viditelnosti a **naměřené
     * ceny posledního snímku** (`pressure` z `framePressure()`).
     *
     * Pod rozpočtem se chová přesně jako dřív. Nad rozpočtem se pásmo, ve
     * kterém se drží neviditelný asset, smrskne z `retainDistance` na
     * `resumeDistance`, takže vzdálené kusy mimo obraz usínají dřív. Co je
     * v obraze nebo je hrdina, se nedotkne ani pod tlakem: uspává se to, co
     * porotce v ten okamžik nevidí.
     */
    decide(input:{id:string;importance:number;distance:number;inFrame:boolean;suspended:boolean;now:number;pressure?:number}):'retain'|'suspend'|'resume' {
      const {id,importance,distance,inFrame,suspended,now,pressure=0}=input;
      if(importance>=LOD_POLICY.heroImportance||inFrame||distance<=ZONE_STREAM_POLICY.resumeDistance) {
        hiddenSince.delete(id);return suspended?'resume':'retain';
      }
      if(suspended)return 'retain';
      const retain=pressure>LOD_POLICY.overBudgetRatio?ZONE_STREAM_POLICY.resumeDistance:ZONE_STREAM_POLICY.retainDistance;
      if(distance<=retain){hiddenSince.delete(id);return 'retain';}
      const since=hiddenSince.get(id)??now;hiddenSince.set(id,since);
      return now-since>=ZONE_STREAM_POLICY.hiddenSeconds?'suspend':'retain';
    },
    prune(ids:ReadonlySet<string>){for(const id of hiddenSince.keys())if(!ids.has(id))hiddenSince.delete(id);},
  };
}
