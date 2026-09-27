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

  // Dávka 3/4: window, workbench, bridge, dog, elevator, lamp.

  const casement = root('framed-window');
  box(casement, 'wall-below', [1.6, 0.9, 0.2], [0, 0.45, 0], plaster);
  box(casement, 'wall-above', [1.6, 0.4, 0.2], [0, 2.2, 0], plaster);
  for (const x of [-0.65, 0.65]) box(casement, 'wall-side', [0.3, 1.1, 0.2], [x, 1.45, 0], plaster);
  for (const x of [-0.46, 0.46]) box(casement, 'frame-jamb', [0.08, 1.1, 0.12], [x, 1.45, 0], wood);
  for (const y of [0.94, 1.96]) box(casement, 'frame-rail', [1.0, 0.08, 0.12], [0, y, 0], wood);
  box(casement, 'sill', [1.12, 0.06, 0.32], [0, 0.93, 0.06], wood);
  const sash = child(casement, 'window-sash', [-0.42, 0.98, 0.03]);
  box(sash, 'sash-glass', [0.84, 0.94, 0.01], [0.42, 0.47, 0], glass);
  box(sash, 'sash-mullion', [0.04, 0.94, 0.04], [0.42, 0.47, 0], wood);
  box(sash, 'sash-transom', [0.84, 0.04, 0.04], [0.42, 0.47, 0], wood);
  cylinder(sash, 'sash-handle', 0.012, 0.012, 0.1, [0.78, 0.4, 0.05], brass);
  add('framed-window', 'Casement window in a wall opening', ['window', 'framed-window', 'casement', 'pane'], casement,
    { sockets: [{ id: 'hinge', at: [-0.42, 0.98, 0.03], normal: [0, 1, 0] }], parts: [{ id: 'sash', node: 'window-sash', pivot: [-0.42, 0.98, 0.03], sockets: ['hinge'] }] });

  const workbench = root('workbench');
  box(workbench, 'top', [1.8, 0.08, 0.7], [0, 0.86, 0], wood);
  for (const x of [-0.8, 0.8]) for (const z of [-0.28, 0.28]) box(workbench, 'leg', [0.08, 0.82, 0.08], [x, 0.41, z], wood);
  box(workbench, 'lower-shelf', [1.6, 0.04, 0.6], [0, 0.25, 0], wood);
  for (const x of [-0.8, 0.8]) box(workbench, 'stretcher', [0.06, 0.06, 0.56], [x, 0.7, 0], wood);
  box(workbench, 'vise-body', [0.2, 0.1, 0.14], [0.65, 0.95, 0.3], iron);
  box(workbench, 'vise-jaw', [0.2, 0.1, 0.04], [0.65, 0.95, 0.42], iron);
  cylinder(workbench, 'vise-screw', 0.015, 0.015, 0.3, [0.65, 0.95, 0.5], metal).rotation.x = Math.PI / 2;
  cylinder(workbench, 'hammer-handle', 0.015, 0.018, 0.3, [-0.4, 0.92, 0.1], wood).rotation.z = Math.PI / 2;
  box(workbench, 'hammer-head', [0.06, 0.05, 0.1], [-0.22, 0.925, 0.1], iron);
  for (let i = 0; i < 3; i++) cylinder(workbench, `jar-${i}`, 0.04, 0.04, 0.1, [-0.7 + i * 0.12, 0.95, -0.22], glass);
  add('workbench', 'Workshop bench with a vise', ['workbench', 'bench-top', 'workshop', 'worktable', 'craft-table'], workbench,
    { supportSurfaces: [{ id: 'top', center: [0, 0.9, 0], width: 1.8, depth: 0.7 }], sockets: [{ id: 'top', at: [0, 0.9, 0], normal: [0, 1, 0] }] });

  const bridge = root('wooden-bridge');
  for (const z of [-2.1, 2.1]) box(bridge, 'abutment', [1.6, 0.4, 1.2], [0, 0.2, z], stone);
  for (let i = 0; i < 9; i++) {
    const z = -1.6 + i * 0.4, y = 0.43 + 0.32 * (1 - (z / 1.8) ** 2);
    box(bridge, `plank-${i}`, [1.4, 0.06, 0.38], [0, y, z], wood);
    if (i % 2 === 0) for (const x of [-0.66, 0.66]) cylinder(bridge, 'post', 0.03, 0.035, 0.9, [x, y + 0.42, z], wood);
  }
  for (const x of [-0.66, 0.66]) for (const [i, z] of [-1.2, 0, 1.2].entries()) box(bridge, `rail-${i}`, [0.05, 0.05, 1.2], [x, 1.3 + 0.32 * (1 - (z / 1.8) ** 2) - (i === 1 ? 0 : 0.06), z], wood).rotation.x = (i - 1) * 0.24;
  add('wooden-bridge', 'Arched wooden footbridge', ['bridge', 'footbridge', 'crossing', 'walkway', 'plank-bridge'], bridge);

  const dog = root('dog');
  ellipsoid(dog, 'body', [0.17, 0.19, 0.36], [0, 0.48, 0], fur);
  ellipsoid(dog, 'chest', [0.17, 0.2, 0.2], [0, 0.46, 0.2], fur);
  ellipsoid(dog, 'head', [0.13, 0.13, 0.15], [0, 0.7, 0.42], fur);
  ellipsoid(dog, 'snout', [0.07, 0.06, 0.11], [0, 0.66, 0.56], fur);
  ellipsoid(dog, 'nose', [0.025, 0.02, 0.02], [0, 0.68, 0.665], dark);
  for (const x of [-0.05, 0.05]) ellipsoid(dog, 'eye', [0.015, 0.015, 0.01], [x, 0.74, 0.54], dark);
  for (const x of [-0.1, 0.1]) ellipsoid(dog, 'ear', [0.04, 0.09, 0.03], [x, 0.72, 0.36], hair).rotation.z = -x * 4;
  for (const x of [-0.1, 0.1]) for (const z of [-0.22, 0.2]) cylinder(dog, 'leg', 0.04, 0.045, 0.36, [x, 0.18, z], fur);
  cylinder(dog, 'tail', 0.015, 0.03, 0.3, [0, 0.62, -0.42], fur).rotation.x = -0.9;
  add('dog', 'Standing dog', ['dog', 'hound', 'puppy', 'pet', 'animal'], dog);

  const elevator = root('elevator-car');
  box(elevator, 'floor', [1.7, 0.1, 1.7], [0, 0.05, 0], dark);
  box(elevator, 'ceiling', [1.7, 0.1, 1.7], [0, 2.45, 0], dark);
  box(elevator, 'back-wall', [1.7, 2.3, 0.08], [0, 1.25, -0.81], metal);
  for (const x of [-0.81, 0.81]) box(elevator, 'side-wall', [0.08, 2.3, 1.7], [x, 1.25, 0], metal);
  for (const x of [-0.72, 0.72]) box(elevator, 'door-post', [0.26, 2.3, 0.08], [x, 1.25, 0.81], dark);
  box(elevator, 'lintel', [1.7, 0.25, 0.08], [0, 2.275, 0.81], dark);
  const doors = child(elevator, 'elevator-doors', [0, 0, 0.8]);
  for (const x of [-0.3, 0.3]) box(doors, 'door-leaf', [0.58, 2.05, 0.05], [x, 1.125, 0], metal);
  box(elevator, 'call-panel', [0.16, 0.3, 0.02], [-0.66, 1.2, 0.86], dark);
  cylinder(elevator, 'call-button', 0.025, 0.025, 0.02, [-0.66, 1.2, 0.88], bulb).rotation.x = Math.PI / 2;
  box(elevator, 'floor-display', [0.4, 0.1, 0.02], [0, 2.3, 0.86], screen);
  add('elevator-car', 'Steel elevator car with sliding doors', ['elevator', 'lift', 'elevator-car', 'hoist'], elevator,
    { sockets: [{ id: 'doorway', at: [0, 0, 0.8], normal: [0, 0, 1] }], parts: [{ id: 'doors', node: 'elevator-doors', pivot: [0, 0, 0.8], sockets: ['doorway'] }] });

  const lamp = root('floor-lamp');
  cylinder(lamp, 'base', 0.18, 0.2, 0.03, [0, 0.015, 0], metal);
  cylinder(lamp, 'pole', 0.018, 0.018, 1.5, [0, 0.78, 0], brass);
  cylinder(lamp, 'shade', 0.25, 0.16, 0.34, [0, 1.65, 0], fabric);
  ellipsoid(lamp, 'bulb', [0.05, 0.07, 0.05], [0, 1.6, 0], bulb);
  cylinder(lamp, 'finial', 0.02, 0.02, 0.06, [0, 1.85, 0], brass);
  add('floor-lamp', 'Floor lamp with a fabric shade', ['lamp', 'floor-lamp', 'reading-lamp', 'lampshade'], lamp);

  // Dávka 4/4: lantern, tent, tower, beacon, building, classroom.

  const lantern = root('hanging-lantern');
  cylinder(lantern, 'post-foot', 0.1, 0.13, 0.08, [0, 0.04, 0], iron);
  cylinder(lantern, 'post', 0.035, 0.045, 1.9, [0, 1.03, 0], iron);
  box(lantern, 'bracket', [0.5, 0.04, 0.04], [0.23, 1.96, 0], iron);
  box(lantern, 'bracket-strut', [0.32, 0.03, 0.03], [0.14, 1.85, 0], iron).rotation.z = 0.6;
  cylinder(lantern, 'hook', 0.012, 0.012, 0.08, [0.45, 1.9, 0], iron);
  const cage = child(lantern, 'lantern-cage', [0.45, 1.86, 0]);
  cone(cage, 'cap', 0.16, 0.1, [0, -0.05, 0], iron);
  box(cage, 'glass-body', [0.18, 0.28, 0.18], [0, -0.26, 0], glass);
  for (const x of [-0.09, 0.09]) for (const z of [-0.09, 0.09]) box(cage, 'cage-bar', [0.02, 0.3, 0.02], [x, -0.26, z], iron);
  box(cage, 'floor-plate', [0.2, 0.03, 0.2], [0, -0.415, 0], iron);
  ellipsoid(cage, 'flame', [0.035, 0.06, 0.035], [0, -0.27, 0], flame);
  add('hanging-lantern', 'Iron lantern hanging from a post', ['lantern', 'oil-lantern', 'lamppost', 'street-lantern'], lantern,
    { sockets: [{ id: 'hook', at: [0.45, 1.86, 0], normal: [0, -1, 0] }], parts: [{ id: 'cage', node: 'lantern-cage', pivot: [0.45, 1.86, 0], sockets: ['hook'] }] });

  const tent = root('canvas-tent');
  box(tent, 'groundsheet', [2.4, 0.02, 2.8], [0, 0.01, 0], dark);
  for (const side of [-1, 1]) box(tent, 'panel', [1.94, 0.03, 2.6], [side * 0.55, 0.81, 0], canvas).rotation.z = -side * 0.9686;
  for (const z of [-1.3, 1.3]) cylinder(tent, 'pole', 0.03, 0.035, 1.6, [0, 0.8, z], wood);
  cylinder(tent, 'ridge', 0.03, 0.03, 2.8, [0, 1.6, 0], wood).rotation.x = Math.PI / 2;
  // Zadní štít jako čtyři stupně, aby nevyčníval z šikmých panelů.
  for (const [i, w] of [1.65, 1.13, 0.6, 0.1].entries()) box(tent, `back-panel-${i}`, [w, 0.38, 0.03], [0, 0.21 + i * 0.38, -1.28], canvas);
  for (const side of [-1, 1]) box(tent, 'flap', [0.5, 1.2, 0.03], [side * 0.7, 0.62, 1.29], canvas).rotation.y = side * 0.5;
  add('canvas-tent', 'A-frame canvas tent', ['tent', 'canvas-tent', 'camp', 'campsite', 'shelter'], tent);

  const tower = root('watchtower');
  for (const x of [-1.0, 1.0]) for (const z of [-1.0, 1.0]) cylinder(tower, 'leg', 0.09, 0.12, 5.0, [x, 2.5, z], wood);
  for (const y of [1.6, 3.4]) {
    for (const x of [-1.0, 1.0]) box(tower, 'brace-side', [0.08, 0.08, 2.0], [x, y, 0], wood);
    for (const z of [-1.0, 1.0]) box(tower, 'brace-front', [2.0, 0.08, 0.08], [0, y, z], wood);
  }
  for (const side of [-1, 1]) box(tower, 'cross-brace', [0.06, 0.06, 2.6], [side * 1.0, 2.5, 0], wood).rotation.x = side * 0.75;
  box(tower, 'platform', [2.8, 0.15, 2.8], [0, 5.075, 0], wood);
  for (const x of [-1.3, 1.3]) for (const z of [-1.3, 1.3]) cylinder(tower, 'rail-post', 0.05, 0.05, 1.0, [x, 5.65, z], wood);
  for (const x of [-1.3, 1.3]) box(tower, 'rail-side', [0.06, 0.06, 2.6], [x, 6.1, 0], wood);
  for (const z of [-1.3, 1.3]) box(tower, 'rail-front', [2.6, 0.06, 0.06], [0, 6.1, z], wood);
  for (const x of [-1.2, 1.2]) for (const z of [-1.2, 1.2]) cylinder(tower, 'roof-post', 0.05, 0.05, 2.0, [x, 6.15, z], wood);
  cone(tower, 'roof', 2.1, 1.3, [0, 7.8, 0], stone);
  cylinder(tower, 'ladder-rail', 0.03, 0.03, 5.0, [0.3, 2.5, 1.2], wood);
  cylinder(tower, 'ladder-rail', 0.03, 0.03, 5.0, [-0.3, 2.5, 1.2], wood);
  if (!lod) for (let i = 0; i < 10; i++) box(tower, `rung-${i}`, [0.6, 0.04, 0.04], [0, 0.4 + i * 0.48, 1.2], wood);
  add('watchtower', 'Timber watchtower with a lookout platform', ['tower', 'watchtower', 'lookout', 'turret'], tower,
    { supportSurfaces: [{ id: 'platform', center: [0, 5.15, 0], width: 2.8, depth: 2.8 }], sockets: [{ id: 'platform', at: [0, 5.15, 0], normal: [0, 1, 0] }] });

  const beacon = root('fire-beacon');
  cylinder(beacon, 'plinth', 0.55, 0.65, 0.3, [0, 0.15, 0], stone);
  cylinder(beacon, 'mast', 0.06, 0.09, 2.9, [0, 1.75, 0], iron);
  for (const [i, a] of [0, 2.094, 4.189].entries()) {
    const stay = child(beacon, `stay-${i}`, [0, 0, 0]); stay.rotation.y = a;
    cylinder(stay, 'stay-rod', 0.02, 0.02, 1.4, [0.27, 0.95, 0], iron).rotation.z = 0.45;
  }
  cylinder(beacon, 'brazier', 0.42, 0.26, 0.36, [0, 3.38, 0], iron);
  for (const [i, a] of [0, 1.047, 2.094].entries()) box(beacon, `grate-${i}`, [0.86, 0.03, 0.03], [0, 3.58, 0], iron).rotation.y = a;
  ellipsoid(beacon, 'fire', [0.3, 0.42, 0.3], [0, 3.85, 0], flame);
  ellipsoid(beacon, 'fire-tip', [0.14, 0.32, 0.14], [0.05, 4.25, -0.03], flame);
  add('fire-beacon', 'Iron fire beacon on a mast', ['beacon', 'warning-beacon', 'fire-beacon', 'brazier'], beacon);

  const building = root('townhouse');
  box(building, 'plinth', [6.2, 0.2, 5.2], [0, 0.1, 0], stone);
  box(building, 'body', [5.8, 6.4, 4.8], [0, 3.4, 0], plaster);
  box(building, 'string-course', [6.0, 0.15, 5.0], [0, 3.3, 0], stone);
  box(building, 'parapet', [6.0, 0.4, 5.0], [0, 6.8, 0], stone);
  box(building, 'door', [1.0, 2.2, 0.1], [0, 1.3, 2.42], dark);
  box(building, 'door-step', [1.4, 0.15, 0.6], [0, 0.275, 2.7], stone);
  for (const [y, x] of [[1.9, -2.0], [1.9, 2.0], [4.9, -2.0], [4.9, 0], [4.9, 2.0]]) {
    box(building, 'window-frame', [0.9, 1.3, 0.08], [x, y, 2.42], wood);
    box(building, 'window-glass', [0.74, 1.14, 0.06], [x, y, 2.45], glass);
  }
  cylinder(building, 'chimney', 0.22, 0.25, 1.2, [-2.2, 7.4, -1.5], stone);
  cylinder(building, 'chimney', 0.22, 0.25, 1.2, [2.2, 7.4, -1.5], stone);
  add('townhouse', 'Two-storey plastered townhouse', ['building', 'townhouse', 'house', 'apartment', 'facade'], building);

  const classroom = root('classroom');
  box(classroom, 'floor', [6.0, 0.1, 5.0], [0, 0.05, 0], wood);
  box(classroom, 'back-wall', [6.0, 3.0, 0.1], [0, 1.6, -2.45], plaster);
  for (const x of [-2.95, 2.95]) box(classroom, 'side-wall', [0.1, 3.0, 5.0], [x, 1.6, 0], plaster);
  box(classroom, 'chalkboard', [3.2, 1.2, 0.05], [0, 1.7, -2.38], dark);
  box(classroom, 'chalk-tray', [3.2, 0.05, 0.1], [0, 1.08, -2.35], wood);
  box(classroom, 'teacher-desk', [1.4, 0.06, 0.7], [0, 0.78, -1.5], wood);
  for (const x of [-0.65, 0.65]) box(classroom, 'teacher-desk-side', [0.06, 0.7, 0.7], [x, 0.45, -1.5], wood);
  for (const row of [0, 1]) for (const col of [-1, 0, 1]) {
    const x = col * 1.8, z = 0.2 + row * 1.6;
    box(classroom, `desk-${row}-${col}`, [1.0, 0.05, 0.55], [x, 0.735, z], wood);
    for (const dx of [-0.45, 0.45]) for (const dz of [-0.22, 0.22]) cylinder(classroom, 'desk-leg', 0.02, 0.02, 0.61, [x + dx, 0.405, z + dz], metal);
    cylinder(classroom, 'seat', 0.17, 0.17, 0.04, [x, 0.5, z + 0.6], fabric);
    cylinder(classroom, 'seat-post', 0.025, 0.03, 0.48, [x, 0.34, z + 0.6], metal);
  }
  add('classroom', 'Classroom with desks and a chalkboard', ['classroom', 'lecture-room', 'schoolroom', 'school'], classroom,
    { supportSurfaces: [{ id: 'teacher-desk', center: [0, 0.81, -1.5], width: 1.4, depth: 0.7 }] });

  // P30B T4: kropítko pro běžce („jumping over sprinklers“) – vygenerované QA 27. 9. zamítla.
  // Čte se vodou: dva oblouky kapek z trysek na rameni a proud nahoru, rozpětí přes šířku překážky.
  const plastic = material('sprinkler-green', '#2f8f4e', { roughness: 0.55 });
  const yellow = material('nozzle-yellow', '#e3b21f', { roughness: 0.45 });
  const spray = material('water-spray', '#5cc3e6', { transparent: true, opacity: 0.8, roughness: 0.1 });
  const drop = () => new T.SphereGeometry(1, lod ? 6 : 10, lod ? 4 : 6);
  const sprinkler = root('sprinkler');
  cylinder(sprinkler, 'base', 0.16, 0.18, 0.04, [0, 0.02, 0], plastic);
  cylinder(sprinkler, 'body', 0.05, 0.07, 0.24, [0, 0.16, 0], plastic);
  cylinder(sprinkler, 'head', 0.075, 0.075, 0.05, [0, 0.305, 0], yellow);
  cylinder(sprinkler, 'arm', 0.022, 0.022, 0.4, [0, 0.335, 0], metal).rotation.z = Math.PI / 2;
  for (const side of [-1, 1]) {
    cone(sprinkler, 'nozzle', 0.035, 0.08, [side * 0.2, 0.365, 0], yellow).rotation.z = -side * 0.6;
    // Kapka i na oblouku x = 0,22 + 0,36 t, y = 0,38 + 1,2 t − 1,45 t², protažená po tečně.
    for (let i = 1; i <= 7; i++) {
      const t = i / 7, size = 0.034 - 0.002 * i;
      const d = mesh(sprinkler, `spray-${side}-${i}`, drop(), spray, [side * (0.22 + 0.36 * t), 0.38 + 1.2 * t - 1.45 * t * t, 0], [size, size * 1.8, size]);
      d.rotation.z = Math.atan2(1.2 - 2.9 * t, side * 0.36) - Math.PI / 2;
    }
  }
  for (let i = 0; i < 3; i++) mesh(sprinkler, `jet-${i}`, drop(), spray, [0, 0.42 + i * 0.09, 0], [0.026, 0.045, 0.026]);
  add('sprinkler', 'Lawn sprinkler spraying water', ['sprinkler', 'sprinklers', 'lawn-sprinkler', 'garden-sprinkler'], sprinkler);

  // P30B T4: klokan-boxer pro souboj („boxing a kangaroo“) – vygenerovaný neprošel bránou kvality.
  // Silueta: vzpřímené tělo, dlouhé uši, velká chodidla, ocas opřený o zem, červené rukavice před hrudí.
  const belly = material('pale-fur', '#d8bf94', { roughness: 0.95 });
  const kangaroo = root('kangaroo');
  const tail = cylinder(kangaroo, 'tail', 0.09, 0.03, 0.62, [0, 0.2, -0.36], fur); tail.rotation.x = 1.1;
  for (const side of [-1, 1]) {
    ellipsoid(kangaroo, 'thigh', [0.1, 0.18, 0.16], [side * 0.12, 0.24, -0.04], fur);
    ellipsoid(kangaroo, 'foot', [0.055, 0.04, 0.2], [side * 0.13, 0.04, 0.08], fur);
    const arm = cylinder(kangaroo, 'arm', 0.03, 0.035, 0.22, [side * 0.13, 0.84, 0.1], fur); arm.rotation.x = 1.2;
    ellipsoid(kangaroo, 'glove', [0.075, 0.07, 0.085], [side * 0.13, 0.82, 0.24], red);
    const ear = ellipsoid(kangaroo, 'ear', [0.035, 0.11, 0.02], [side * 0.065, 1.32, 0.0], fur); ear.rotation.z = -side * 0.25;
    ellipsoid(kangaroo, 'eye', [0.016, 0.02, 0.012], [side * 0.05, 1.19, 0.15], dark);
  }
  ellipsoid(kangaroo, 'body', [0.19, 0.34, 0.17], [0, 0.66, -0.02], fur).rotation.x = 0.15;
  ellipsoid(kangaroo, 'belly', [0.13, 0.24, 0.08], [0, 0.62, 0.09], belly);
  ellipsoid(kangaroo, 'head', [0.1, 0.1, 0.12], [0, 1.15, 0.05], fur);
  ellipsoid(kangaroo, 'snout', [0.06, 0.055, 0.08], [0, 1.11, 0.16], fur);
  ellipsoid(kangaroo, 'nose', [0.025, 0.018, 0.015], [0, 1.13, 0.235], dark);
  add('kangaroo', 'Boxing kangaroo with red gloves', ['kangaroo', 'kangaroos', 'roo', 'roos', 'wallaby'], kangaroo);
  return models;
}
