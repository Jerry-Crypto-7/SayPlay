'use client';

import { useEffect, useState } from 'react';
import catalog from '@/assets/catalog.json';
import { blueprintSchema } from '@/worldstream/schema';
import { buildProxyWorldFrom, type ProxyWorld } from '@/worldstream/proxy';
import WorldstreamCanvas from '@/components/worldstream/WorldstreamCanvas';
import { DEMO_BLUEPRINT } from '../demo-world';

/** Manual loader/lifetime fixture; it uses the production proxy and stage. */
export default function AssetGallery() {
  const [mode, setMode] = useState<'all' | 'one' | 'empty'>('all');
  const [lod, setLod] = useState(0);
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    if (mode === 'empty') {
      // Unmount representations directly: a valid blueprint always has objects.
      setWorld(current => current?.kind === 'built' ? { ...current, slots: [] } : current);
      return;
    }
    const entries = [...catalog.assets, catalog.assets[0]];
    const objects = entries.flatMap((asset, index) => {
      if (mode === 'one' && index === 0) return [];
      const x = (index % 4 - 1.5) * 3;
      const z = Math.floor(index / 4) * 4 - 2;
      return [{ stableId: `sample${index}`, label: asset.label, synonyms: [], role: 'prop', importance: 2,
        source: { kind: 'asset', assetId: asset.assetId, version: asset.version, hash: asset.hash },
        binding: { collider: { min: [x - 1.2, 0, z - 1.2], max: [x + 1.2, 2.8, z + 1.2] }, sockets: [], parts: [] },
        targetBounds: { min: [x - 1.2, 0, z - 1.2], max: [x + 1.2, 2.8, z + 1.2] } }];
    });
    const blueprint = blueprintSchema.safeParse({ ...DEMO_BLUEPRINT, version: 'worldstream-v2', title: 'GLB catalog', objects, shapes: [],
      geometry: { ...DEMO_BLUEPRINT.geometry, nodes: [{ kind: 'terrain', variant: 'ridge', extent: [15, 9], amplitude: 0, seed: 1 }], root: 0 } });
    if (!blueprint.success) { setError(blueprint.error.message); return; }
    void buildProxyWorldFrom(blueprint.data, { mesh: async () => { throw new Error('No shapes in asset gallery'); } })
      .then(built => {
        if (!active) return;
        if (built.kind === 'built') built = { ...built, slots: built.slots.map(entry => entry.form.kind === 'asset'
          ? { ...entry, form: { ...entry.form, level: lod } } : entry) };
        setWorld(built);
      }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [mode, lod]);
  return <main style={{ height: '100vh' }}>
    <WorldstreamCanvas world={world} />
    <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, background: '#14232e', padding: 12 }}>
      <strong>GLB catalog · production renderer</strong>{' '}
      <button onClick={() => setMode('one')}>Remove first instance</button>{' '}
      <button onClick={() => setMode('empty')}>Unload all</button>{' '}
      <button onClick={() => setMode('all')}>Load all</button>{' '}
      <button onClick={() => setLod(value => 1 - value)}>LOD {lod}</button>
      {error && <p role="alert">{error}</p>}
    </div>
  </main>;
}
