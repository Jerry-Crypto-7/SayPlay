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
  // Paleta pro 24 modelů z naměřené poptávky (P22 T11); žádná fialová.
  const stone = material('grey-stone', '#8d8a82', { roughness: 0.9 });
  const plaster = material('warm-plaster', '#d9cfb8', { roughness: 0.85 });
  const iron = material('cast-iron', '#3d4046', { metalness: 0.6, roughness: 0.45 });
  const brass = material('aged-brass', '#b08d4a', { metalness: 0.7, roughness: 0.35 });
  const canvas = material('sand-canvas', '#c9b58a', { roughness: 0.95 });
  const fur = material('tan-fur', '#8a6a4a', { roughness: 0.95 });
  const red = material('alarm-red', '#c0392b', { roughness: 0.4 });
  const bulb = material('warm-bulb', '#f6d78a', { emissive: '#f0c05a' });
  const flame = material('open-flame', '#f28b2a', { emissive: '#e0601a' });
  function mesh(parent, name, geometry, mat, at, scale) {
    // These models do not use textures; discard unused UVs before export.
    geometry.deleteAttribute('uv');
    const m = new T.Mesh(geometry, mat); m.name = name; m.position.set(...at);
    if (scale) m.scale.set(...scale); parent.add(m); return m;
  }
  const box = (p, n, size, at, mat) => mesh(p, n, new T.BoxGeometry(...size), mat, at);
  const ellipsoid = (p, n, size, at, mat) => mesh(p, n, new T.SphereGeometry(1, segments, segments / 2), mat, at, size);
  const cylinder = (p, n, top, bottom, h, at, mat) => mesh(p, n, new T.CylinderGeometry(top, bottom, h, segments), mat, at);
  const cone = (p, n, radius, h, at, mat) => mesh(p, n, new T.ConeGeometry(radius, h, segments), mat, at);
  const root = (name) => { const g = new T.Group(); g.name = name; return g; };
  /** Pojmenovaná podskupina s vlastním pivotem – pro pohyblivé díly (`parts`). */
  const child = (parent, name, at) => { const g = root(name); g.position.set(...at); parent.add(g); return g; };
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

  // --- P22 T11: 24 druhů z naměřené poptávky (evals/worldstream/gauntlet/asset-demand.json → top24) ---
  // Dávka 1/4: tree, table, gate, boat, machine, cabinet.

  const tree = root('oak-tree');
  cylinder(tree, 'trunk', 0.14, 0.22, 2.0, [0, 1.0, 0], wood);
  for (const [i, a] of [0.4, 2.5, 4.4].entries()) box(tree, `root-${i}`, [0.5, 0.12, 0.16], [Math.sin(a) * 0.3, 0.06, Math.cos(a) * 0.3], wood).rotation.y = a;
  for (const [i, a] of [0.8, 2.9, 5.0].entries()) {
    const branch = cylinder(tree, `branch-${i}`, 0.05, 0.09, 1.1, [Math.sin(a) * 0.4, 2.2, Math.cos(a) * 0.4], wood);
    branch.rotation.set(Math.cos(a) * 0.7, 0, -Math.sin(a) * 0.7);
  }
  ellipsoid(tree, 'canopy-core', [1.4, 1.1, 1.4], [0, 3.1, 0], leaf);
  for (const [i, a] of [0.5, 1.9, 3.3, 4.7].entries()) ellipsoid(tree, `canopy-${i}`, [0.9, 0.75, 0.9], [Math.sin(a) * 0.95, 2.85 + (i % 2) * 0.35, Math.cos(a) * 0.95], leaf);
  ellipsoid(tree, 'canopy-top', [0.8, 0.7, 0.8], [0.1, 3.9, -0.1], leaf);
  add('oak-tree', 'Broad oak tree', ['tree', 'oak', 'trunk', 'canopy', 'nature'], tree);

  const table = root('dining-table');
  box(table, 'top', [1.6, 0.05, 0.9], [0, 0.725, 0], wood);
  box(table, 'apron', [1.45, 0.08, 0.75], [0, 0.66, 0], wood);
  for (const x of [-0.7, 0.7]) for (const z of [-0.37, 0.37]) cylinder(table, 'leg', 0.032, 0.026, 0.7, [x, 0.35, z], wood);
  add('dining-table', 'Walnut dining table', ['table', 'dining-table', 'desk', 'tabletop', 'furniture'], table,
    { supportSurfaces: [{ id: 'top', center: [0, 0.75, 0], width: 1.6, depth: 0.9 }], sockets: [{ id: 'top', at: [0, 0.75, 0], normal: [0, 1, 0] }] });

  const gate = root('iron-gate');
  for (const x of [-1.0, 1.0]) { box(gate, 'pillar', [0.4, 2.2, 0.4], [x, 1.1, 0], stone); box(gate, 'pillar-cap', [0.5, 0.12, 0.5], [x, 2.26, 0], stone); }
  const gateLeaf = child(gate, 'gate-leaf', [-0.8, 0, 0]);
  for (const y of [0.25, 1.75]) box(gateLeaf, 'rail', [1.6, 0.06, 0.05], [0.8, y, 0], iron);
  for (let i = 0; i < 7; i++) cylinder(gateLeaf, `bar-${i}`, 0.02, 0.02, 1.7, [0.1 + i * 0.2333, 0.95, 0], iron);
  if (!lod) for (let i = 0; i < 7; i++) cone(gateLeaf, `spike-${i}`, 0.035, 0.1, [0.1 + i * 0.2333, 1.85, 0], iron);
  for (const y of [0.4, 1.6]) cylinder(gateLeaf, 'hinge', 0.035, 0.035, 0.12, [0, y, 0], iron);
  add('iron-gate', 'Wrought iron gate between stone pillars', ['gate', 'iron-gate', 'entrance', 'fence', 'portal'], gate,
    { sockets: [{ id: 'hinge', at: [-0.8, 0, 0], normal: [0, 1, 0] }], parts: [{ id: 'leaf', node: 'gate-leaf', pivot: [-0.8, 0, 0], sockets: ['hinge'] }] });

  const boat = root('rowing-boat');
  ellipsoid(boat, 'hull', [0.7, 0.36, 1.6], [0, 0.36, 0], wood);
  ellipsoid(boat, 'hull-inner', [0.6, 0.3, 1.45], [0, 0.44, 0], material('pale-plank', '#a98b62'));
  box(boat, 'keel', [0.06, 0.08, 2.6], [0, 0.04, 0], wood);
  for (const z of [-0.55, 0.45]) box(boat, 'thwart', [1.15, 0.05, 0.25], [0, 0.58, z], wood);
  cone(boat, 'bow-post', 0.05, 0.3, [0, 0.75, 1.5], wood);
  for (const side of [-1, 1]) {
    const oar = cylinder(boat, 'oar', 0.02, 0.02, 2.0, [side * 0.75, 0.62, 0.1], wood);
    oar.rotation.set(0, 0, side * 1.25);
    box(boat, 'oar-blade', [0.3, 0.02, 0.12], [side * 1.7, 0.32, 0.1], wood);
  }
  add('rowing-boat', 'Wooden rowing boat with oars', ['boat', 'rowboat', 'ship', 'vessel', 'hull'], boat);

  const machine = root('steam-machine');
  box(machine, 'base', [1.4, 0.2, 0.9], [0, 0.1, 0], dark);
  box(machine, 'body', [1.0, 0.8, 0.7], [0, 0.6, 0], metal);
  cylinder(machine, 'boiler', 0.3, 0.3, 0.95, [0, 1.3, 0], brass).rotation.z = Math.PI / 2;
  cylinder(machine, 'chimney', 0.07, 0.09, 0.7, [-0.3, 1.9, 0], iron);
  cylinder(machine, 'flywheel', 0.35, 0.35, 0.08, [0.65, 0.6, 0], iron).rotation.z = Math.PI / 2;
  cylinder(machine, 'axle', 0.05, 0.05, 0.5, [0.55, 0.6, 0], metal).rotation.z = Math.PI / 2;
  cylinder(machine, 'gauge', 0.09, 0.09, 0.03, [0.25, 0.75, 0.36], screen).rotation.x = Math.PI / 2;
  cylinder(machine, 'pipe', 0.04, 0.04, 0.6, [0.35, 1.0, -0.2], brass);
  if (!lod) for (let i = 0; i < 6; i++) box(machine, `rivet-row-${i}`, [0.03, 0.03, 0.72], [-0.45 + i * 0.18, 1.0, 0], iron);
  add('steam-machine', 'Brass and iron steam machine', ['machine', 'engine', 'boiler', 'generator', 'contraption', 'mechanism'], machine);

  const cabinet = root('storage-cabinet');
  box(cabinet, 'plinth', [0.86, 0.08, 0.46], [0, 0.04, 0], dark);
  box(cabinet, 'carcass', [0.9, 1.8, 0.5], [0, 0.98, 0], wood);
  const panel = material('warm-panel', '#8b6143');
  box(cabinet, 'fixed-door', [0.42, 1.6, 0.03], [0.22, 0.98, 0.26], panel);
  cylinder(cabinet, 'fixed-handle', 0.012, 0.012, 0.14, [0.06, 0.98, 0.29], metal);
  const cabinetDoor = child(cabinet, 'cabinet-door', [-0.44, 0, 0.26]);
  box(cabinetDoor, 'door-slab', [0.42, 1.6, 0.03], [0.22, 0.98, 0], panel);
  cylinder(cabinetDoor, 'door-handle', 0.012, 0.012, 0.14, [0.38, 0.98, 0.03], metal);
  add('storage-cabinet', 'Tall walnut storage cabinet', ['cabinet', 'cupboard', 'wardrobe', 'shelf', 'storage'], cabinet,
    { supportSurfaces: [{ id: 'top', center: [0, 1.88, 0], width: 0.9, depth: 0.5 }], sockets: [{ id: 'hinge', at: [-0.44, 0, 0.26], normal: [0, 1, 0] }],
      parts: [{ id: 'door', node: 'cabinet-door', pivot: [-0.44, 0, 0.26], sockets: ['hinge'] }] });

  // Dávka 2/4: stool, switch, button, cabin, lever, wall.

  const stool = root('bar-stool');
  cylinder(stool, 'seat-pad', 0.18, 0.18, 0.05, [0, 0.725, 0], fabric);
  cylinder(stool, 'seat-plate', 0.16, 0.16, 0.02, [0, 0.69, 0], wood);
  for (const [i, a] of [0.785, 2.356, 3.927, 5.498].entries()) cylinder(stool, `leg-${i}`, 0.02, 0.024, 0.68, [Math.sin(a) * 0.14, 0.34, Math.cos(a) * 0.14], wood);
  for (const [i, a] of [0, 1.571].entries()) box(stool, `footrest-${i}`, [0.3, 0.025, 0.025], [0, 0.25, 0], wood).rotation.y = a;
  add('bar-stool', 'Round wooden stool', ['stool', 'bar-stool', 'perch', 'footstool'], stool,
    { supportSurfaces: [{ id: 'seat', center: [0, 0.75, 0], width: 0.36, depth: 0.36 }], sockets: [{ id: 'seat', at: [0, 0.75, 0], normal: [0, 1, 0] }] });

  const wallSwitch = root('wall-switch');
  box(wallSwitch, 'console', [0.4, 1.0, 0.3], [0, 0.5, 0], dark);
  box(wallSwitch, 'console-foot', [0.5, 0.05, 0.4], [0, 0.025, 0], metal);
  box(wallSwitch, 'face-plate', [0.22, 0.22, 0.02], [0, 1.05, 0.16], metal);
  const toggle = child(wallSwitch, 'switch-toggle', [0, 1.05, 0.17]);
  cylinder(toggle, 'toggle-lever', 0.02, 0.028, 0.12, [0, 0.03, 0.045], brass).rotation.x = 0.6;
  ellipsoid(toggle, 'toggle-tip', [0.028, 0.028, 0.028], [0, 0.075, 0.08], red);
  for (const y of [-0.08, 0.08]) cylinder(wallSwitch, 'plate-screw', 0.008, 0.008, 0.01, [0, 1.05 + y, 0.175], iron).rotation.x = Math.PI / 2;
  add('wall-switch', 'Toggle switch on a control console', ['switch', 'toggle', 'wall-switch', 'control'], wallSwitch,
    { sockets: [{ id: 'axis', at: [0, 1.05, 0.17], normal: [0, 0, 1] }], parts: [{ id: 'toggle', node: 'switch-toggle', pivot: [0, 1.05, 0.17], sockets: ['axis'] }] });

  const button = root('push-button');
  cylinder(button, 'pedestal', 0.16, 0.22, 0.9, [0, 0.45, 0], metal);
  cylinder(button, 'top-plate', 0.22, 0.22, 0.05, [0, 0.925, 0], dark);
  cylinder(button, 'guard-ring', 0.14, 0.14, 0.03, [0, 0.965, 0], brass);
  const cap = child(button, 'button-cap', [0, 0.95, 0]);
  cylinder(cap, 'cap-dome', 0.1, 0.11, 0.07, [0, 0.055, 0], red);
  ellipsoid(cap, 'cap-top', [0.1, 0.02, 0.1], [0, 0.09, 0], red);
  box(button, 'label-plate', [0.16, 0.05, 0.01], [0, 0.85, 0.2], brass);
  add('push-button', 'Large red push button on a pedestal', ['button', 'push-button', 'pushbutton', 'control-button'], button,
    { sockets: [{ id: 'press', at: [0, 0.95, 0], normal: [0, 1, 0] }], parts: [{ id: 'cap', node: 'button-cap', pivot: [0, 0.95, 0], sockets: ['press'] }] });

  const cabin = root('log-cabin');
  box(cabin, 'foundation', [4.0, 0.3, 3.5], [0, 0.15, 0], stone);
  box(cabin, 'walls', [3.9, 2.2, 3.4], [0, 1.4, 0], wood);
  for (let i = 0; i < 7; i++) {
    const y = 0.45 + i * 0.28;
    for (const z of [-1.72, 1.72]) cylinder(cabin, `log-front-${i}`, 0.12, 0.12, 4.0, [0, y, z], wood).rotation.z = Math.PI / 2;
    for (const x of [-1.97, 1.97]) cylinder(cabin, `log-side-${i}`, 0.12, 0.12, 3.5, [x, y, 0], wood).rotation.x = Math.PI / 2;
  }
  for (const side of [-1, 1]) box(cabin, 'roof-slope', [4.8, 0.1, 2.3], [0, 3.1, side * 0.95], stone).rotation.x = side * 0.62;
  box(cabin, 'gable', [3.6, 1.2, 0.2], [0, 3.05, 0], wood);
  box(cabin, 'door', [0.8, 1.7, 0.08], [0.4, 1.15, 1.86], dark);
  box(cabin, 'window', [0.7, 0.6, 0.08], [-1.0, 1.7, 1.86], glass);
  box(cabin, 'chimney', [0.4, 1.2, 0.4], [-1.3, 3.5, -0.5], stone);
  add('log-cabin', 'Log cabin with a pitched roof', ['cabin', 'log-cabin', 'hut', 'cottage', 'lodge'], cabin);

  const lever = root('floor-lever');
  box(lever, 'base-plate', [0.5, 0.1, 0.3], [0, 0.05, 0], metal);
  box(lever, 'housing', [0.3, 0.2, 0.2], [0, 0.2, 0], dark);
  cylinder(lever, 'pivot-pin', 0.04, 0.04, 0.34, [0, 0.3, 0], iron).rotation.z = Math.PI / 2;
  const arm = child(lever, 'lever-arm', [0, 0.3, 0]);
  cylinder(arm, 'arm-rod', 0.025, 0.03, 0.9, [0, 0.395, -0.216], iron).rotation.x = -0.5;
  ellipsoid(arm, 'arm-knob', [0.06, 0.06, 0.06], [0, 0.79, -0.43], red);
  box(lever, 'slot-guard', [0.06, 0.04, 0.32], [0, 0.32, -0.06], metal);
  add('floor-lever', 'Floor-mounted pull lever', ['lever', 'floor-lever', 'handle', 'pull-lever'], lever,
    { sockets: [{ id: 'axis', at: [0, 0.3, 0], normal: [1, 0, 0] }], parts: [{ id: 'arm', node: 'lever-arm', pivot: [0, 0.3, 0], sockets: ['axis'] }] });

  const wall = root('stone-wall');
  box(wall, 'footing', [3.0, 0.15, 0.5], [0, 0.075, 0], stone);
  box(wall, 'body', [3.0, 1.8, 0.4], [0, 1.05, 0], plaster);
  box(wall, 'coping', [3.1, 0.1, 0.5], [0, 2.0, 0], stone);
  for (const x of [-1.45, 1.45]) cylinder(wall, 'pier', 0.16, 0.18, 2.05, [x, 1.025, 0], stone);
  if (!lod) for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) box(wall, `block-${r}-${c}`, [0.44, 0.22, 0.03], [-1.1 + c * 0.5 + (r % 2) * 0.25, 0.32 + r * 0.28, 0.205], stone);
  add('stone-wall', 'Plastered stone wall segment', ['wall', 'stone-wall', 'rampart', 'partition', 'barrier'], wall);
  return models;
}
