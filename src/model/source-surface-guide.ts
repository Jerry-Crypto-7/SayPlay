/** Syntax example only: a switch opens a gate until its timer expires. Not a source oracle. */
export const SOURCE_SYNTAX_EXAMPLE = {
  layout: { kind: 'room', width: 5, height: 3 }, grid: { cell: 1 },
  sockets: { spawn: [0, 1], button: [1, 1], exit: [4, 1] }, collisionAabb: {},
  entities: { operator: { role: 'actor', socket: 'spawn' }, button: { role: 'sensor', socket: 'button' },
    gate: { role: 'display', socket: 'exit', locked: true } },
  state: { flags: { started: false }, timers: { window: { durationTicks: 40, initial: 0 } },
    zones: { adjacent: [[0, 1, 1, 1], [2, 1, 1, 1], [1, 0, 1, 1], [1, 2, 1, 1]] } },
  rules: {
    press: { event: { kind: 'onAction', actionId: 'press', target: 'button' }, condition: { kind: 'allOf', operands: [
      { kind: 'flagIs', ref: 'started', value: false }, { kind: 'inZone', entity: 'operator', zone: 'adjacent' },
      { kind: 'lockedIs', target: 'gate', value: true },
    ] }, actions: [{ kind: 'setFlag', ref: 'started', value: true }, { kind: 'setLocked', target: 'gate', value: false },
      { kind: 'startTimer', ref: 'window', durationTicks: 40 }] },
    expiry: { event: { kind: 'onTimerEnd', timer: 'window' }, condition: { kind: 'flagIs', ref: 'started', value: true },
      actions: [{ kind: 'setLocked', target: 'gate', value: true }] },
  }, witness: { tier: 'short', ops: [] },
};

export const SOURCE_SURFACE_GUIDE = [
  'Exact sim wire format (the vocabulary alone is not the JSON shape):',
  'sockets is an ID-keyed map of [x,y] arrays, never {x,y} objects. entities is an ID-keyed map; each entity uses role and socket, not kind or position. Preserve identifiers explicitly requested by the source.',
  'collisionAabb is an ID-keyed object, {} for none, never an array. state.flags maps IDs to booleans. state.timers maps IDs to {durationTicks,initial}. state.zones maps zone IDs to arrays of [x,y,width,height] rectangles. Zones are not sockets or entities.',
  'rules is an ID-keyed map. Every rule has event, condition, actions. Compound conditions use {kind:"allOf",operands:[...]}, never args, conditions or children. flagIs uses ref/value; lockedIs uses target/value; inZone uses entity/zone; timerRunning uses ref.',
  'Actions: setFlag uses ref/value, setLocked uses target/value, startTimer uses ref/durationTicks, stopTimer uses ref. onTimerEnd uses timer, not ref. onAction uses actionId and target.',
  'The engine already creates canonical moveTo inputs to entities with sockets. Do not emit extra moveTo rules or invent a movement configuration. This built-in behavior needs no source rule binding. Do not put goals or descriptive prose in sim fields.',
  'Example below illustrates syntax only and has different behavior from the source. Do not copy its identifiers, duration, outcome, or evidence; generate the source behavior. Emit sim itself under the reply sim field, not another WorldDoc wrapper.',
  JSON.stringify(SOURCE_SYNTAX_EXAMPLE),
].join('\n');
