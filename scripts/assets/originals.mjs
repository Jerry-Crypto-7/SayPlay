/** Original Worldsmith starter models. Coordinates: meters, +Y up, +Z front.
 * No downloaded geometry, textures or training assets are used. */
import * as T from 'three';

export function buildModels(lod = 0) {
  const segments = lod ? 8 : 20;
  const material = (name, color, extra = {}) => new T.MeshStandardMaterial({ name, color, roughness: 0.6, metalness: 0, ...extra });
  const wood = material('oiled-walnut', '#704c34');
  const metal = material('brushed-steel', '#7b8792', { metalness: 0.8, roughness: 0.28 });
  const dark = material('charcoal-polymer', '#202b35');
  const fabric = material('teal-woven-fabric', '#23777c', { roughness: 0.95 });
  const skin = material('warm-skin', '#ba8160');
  const hair = material('dark-hair', '#30241e');
  const leaf = material('leaf-green', '#36734b', { roughness: 0.85 });
  const glass = material('transparent-aquarium-glass', '#a4d8df', { transparent: true, opacity: 0.18, roughness: 0.12, side: T.DoubleSide, depthWrite: false });
  const water = material('transparent-water', '#279cae', { transparent: true, opacity: 0.22, roughness: 0.08, side: T.DoubleSide, depthWrite: false });
  const fish = material('golden-fish', '#ed9437');
  const soil = material('dark-soil', '#332a22');
  const terracotta = material('terracotta', '#be6946');
  const screen = material('display', '#194963', { emissive: '#184759' });
  function mesh(parent, name, geometry, mat, at, scale) {
    // These models do not use textures; discard unused UVs before export.
    geometry.deleteAttribute('uv');
    const m = new T.Mesh(geometry, mat); m.name = name; m.position.set(...at);
    if (scale) m.scale.set(...scale); parent.add(m); return m;
  }
  const box = (p, n, size, at, mat) => mesh(p, n, new T.BoxGeometry(...size), mat, at);
  const ellipsoid = (p, n, size, at, mat) => mesh(p, n, new T.SphereGeometry(1, segments, segments / 2), mat, at, size);
  const cylinder = (p, n, top, bottom, h, at, mat) => mesh(p, n, new T.CylinderGeometry(top, bottom, h, segments), mat, at);
  const root = (name) => { const g = new T.Group(); g.name = name; return g; };
  const models = [];
  const add = (id, label, tags, scene, extras = {}) => models.push({ id, label, tags, scene, sockets: [], parts: [], supportSurfaces: [], ...extras });

  const aquarium = root('aquarium');
  box(aquarium, 'base', [1.02, 0.08, 0.5], [0, 0.04, 0], dark);
  for (const z of [-0.235, 0.235]) box(aquarium, `glass-${z}`, [0.96, 0.55, 0.012], [0, 0.355, z], glass);
  for (const x of [-0.474, 0.474]) box(aquarium, `glass-side-${x}`, [0.012, 0.55, 0.46], [x, 0.355, 0], glass);
  box(aquarium, 'water', [0.93, 0.46, 0.44], [0, 0.33, 0], water);
  box(aquarium, 'sand', [0.94, 0.035, 0.45], [0, 0.0975, 0], material('sand', '#bcaa81'));
  for (const x of [-0.48, 0.48]) box(aquarium, 'rim-side', [0.025, 0.035, 0.48], [x, 0.64, 0], dark);
  for (const z of [-0.235, 0.235]) box(aquarium, 'rim-front-back', [0.98, 0.035, 0.025], [0, 0.64, z], dark);
  for (const [i, x] of [-0.22, 0.18].entries()) {
    ellipsoid(aquarium, `fish-${i}`, [0.085, 0.04, 0.025], [x, 0.3 + i * 0.15, 0.045], fish);
    const tail = mesh(aquarium, `tail-${i}`, new T.ConeGeometry(0.045, 0.07, lod ? 3 : 4), fish, [x - 0.1, 0.3 + i * 0.15, 0.045], [1, 1, 0.45]); tail.rotation.z = -Math.PI / 2;
  }
  for (let i = 0; i < 4; i++) ellipsoid(aquarium, 'aquatic-leaf', [0.025, 0.14 + i * 0.015, 0.015], [-0.32 + i * 0.025, 0.23, -0.13], leaf).rotation.z = (i - 1.5) * 0.2;
  add('aquarium', 'Glass aquarium with fish', ['aquarium', 'glass', 'transparent', 'fish'], aquarium);

  const person = root('seated-person');
  ellipsoid(person, 'torso', [0.21, 0.28, 0.14], [0, 0.86, -0.08], fabric);
  cylinder(person, 'neck', 0.062, 0.067, 0.12, [0, 1.16, -0.07], skin);
  ellipsoid(person, 'head', [0.115, 0.145, 0.11], [0, 1.32, -0.065], skin);
  ellipsoid(person, 'hair', [0.12, 0.08, 0.113], [0, 1.405, -0.078], hair);
  ellipsoid(person, 'nose', [0.025, 0.032, 0.03], [0, 1.32, 0.042], skin);
  for (const x of [-0.04, 0.04]) ellipsoid(person, 'eye', [0.009, 0.009, 0.008], [x, 1.35, 0.039], dark);
  for (const side of [-1, 1]) {
    ellipsoid(person, 'thigh', [0.094, 0.105, 0.23], [side * 0.115, 0.52, 0.13], dark);
    ellipsoid(person, 'shin', [0.073, 0.21, 0.072], [side * 0.115, 0.27, 0.3], dark);
    ellipsoid(person, 'shoe', [0.085, 0.055, 0.14], [side * 0.115, 0.055, 0.36], hair);
    ellipsoid(person, 'upper-arm', [0.07, 0.19, 0.075], [side * 0.24, 0.89, -0.04], fabric).rotation.z = side * 0.1;
    ellipsoid(person, 'forearm', [0.055, 0.055, 0.16], [side * 0.24, 0.71, 0.09], skin);
    ellipsoid(person, 'hand', [0.055, 0.028, 0.068], [side * 0.23, 0.69, 0.24], skin);
  }
  add('seated-person', 'Seated person', ['human', 'person', 'seated', 'listener'], person, { sockets: [{ id: 'seat', at: [0, 0.46, -0.05], normal: [0, -1, 0] }] });

  const device = root('desktop-terminal');
  box(device, 'foot', [0.36, 0.025, 0.23], [0, 0.0125, 0], metal);
  box(device, 'stand', [0.07, 0.21, 0.055], [0, 0.12, -0.045], metal);
  box(device, 'monitor', [0.59, 0.36, 0.045], [0, 0.37, -0.035], dark);
  box(device, 'screen', [0.54, 0.3, 0.003], [0, 0.375, -0.01], screen);
  for (let i = 0; i < 3; i++) box(device, 'screen-line', [0.21 + i * 0.05, 0.015, 0.001], [-0.06 + i * 0.025, 0.42 - i * 0.05, -0.008], material(`display-line-${i}`, '#7bb9bd'));
  box(device, 'keyboard', [0.4, 0.025, 0.14], [0, 0.015, 0.2], dark);
  if (!lod) for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) box(device, 'key', [0.027, 0.008, 0.025], [-0.16 + c * 0.035, 0.031, 0.158 + r * 0.035], metal);
  add('desktop-terminal', 'Desktop computer terminal', ['device', 'computer', 'monitor', 'terminal'], device);

  const chair = root('lounge-chair');
  box(chair, 'seat-frame', [0.61, 0.08, 0.59], [0, 0.42, 0], wood);
  box(chair, 'seat-cushion', [0.55, 0.13, 0.54], [0, 0.5, 0], fabric);
  const back = box(chair, 'back-cushion', [0.55, 0.54, 0.13], [0, 0.79, -0.245], fabric); back.rotation.x = -0.1;
  for (const x of [-0.275, 0.275]) {
    for (const z of [-0.23, 0.23]) cylinder(chair, 'leg', 0.027, 0.019, 0.4, [x, 0.2, z], wood);
    box(chair, 'arm', [0.065, 0.065, 0.55], [x, 0.68, 0], wood);
    box(chair, 'arm-post', [0.035, 0.2, 0.035], [x, 0.56, 0.21], wood);
  }
  add('lounge-chair', 'Walnut lounge chair', ['chair', 'furniture', 'seat'], chair, { supportSurfaces: [{ id: 'seat', center: [0, 0.565, 0], width: 0.55, depth: 0.54 }], sockets: [{ id: 'seat', at: [0, 0.565, 0], normal: [0, 1, 0] }] });

  const plant = root('potted-plant');
  cylinder(plant, 'pot', 0.22, 0.15, 0.35, [0, 0.175, 0], terracotta);
  cylinder(plant, 'pot-rim', 0.232, 0.232, 0.04, [0, 0.34, 0], terracotta);
  cylinder(plant, 'soil', 0.207, 0.207, 0.01, [0, 0.362, 0], soil);
  cylinder(plant, 'stem', 0.012, 0.02, 0.87, [0, 0.8, 0], wood);
  for (let i = 0; i < 11; i++) {
    const a = i * 2.4, h = 0.58 + i * 0.06;
    const l = ellipsoid(plant, `leaf-${i}`, [0.115, 0.035, 0.24], [Math.sin(a) * 0.16, h, Math.cos(a) * 0.16], leaf);
    l.rotation.set(-0.28, a, 0);
  }
  add('potted-plant', 'Broadleaf potted plant', ['organic', 'plant', 'foliage', 'pot'], plant);

  const door = root('panel-door');
  for (const x of [-0.51, 0.51]) box(door, 'frame-post', [0.08, 2.12, 0.14], [x, 1.06, 0], wood);
  box(door, 'frame-header', [1.1, 0.08, 0.14], [0, 2.16, 0], wood);
  const doorLeaf = root('door-leaf'); doorLeaf.position.set(-0.47, 0, 0); door.add(doorLeaf);
  box(doorLeaf, 'leaf-slab', [0.94, 2.08, 0.045], [0.47, 1.04, 0], wood);
  for (const y of [0.55, 1.55]) for (const z of [-0.027, 0.027]) box(doorLeaf, 'raised-panel', [0.7, 0.75, 0.012], [0.47, y, z], material('warm-panel', '#8b6143'));
  for (const z of [-0.065, 0.065]) { box(doorLeaf, 'handle-plate', [0.045, 0.17, 0.017], [0.84, 1.02, z], metal); box(doorLeaf, 'lever', [0.12, 0.022, 0.025], [0.8, 1.04, z * 1.4], metal); }
  for (const y of [0.3, 1.8]) cylinder(doorLeaf, 'hinge', 0.013, 0.013, 0.13, [0, y, 0], metal);
  add('panel-door', 'Panel door with hinged leaf', ['door', 'hinge', 'architecture'], door, { sockets: [{ id: 'hinge', at: [-0.47, 0, 0], normal: [0, 1, 0] }], parts: [{ id: 'leaf', node: 'door-leaf', pivot: [-0.47, 0, 0], sockets: ['hinge'] }] });
  return models;
}
