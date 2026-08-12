/**
 * AST pravidlo pro podmínku 5 totality — **rozsahem je tiková cesta, ne adresář**.
 *
 * Je to modul, ne část testu, ze dvou důvodů. Test nad ním musí umět pustit
 * analýzu na **syntetický zdroj** (pravidlo, které nikdo nezkusil shodit, je jen
 * dekorace), a soubor s testy i s analyzátorem přerostl strop projektu.
 *
 * **Proč uzávěr importů.** Původní znění skenovalo `src/sim/`, jenže `step()`
 * z toho adresáře vystupuje: `evalBool` a `evalNode` jsou v `src/ir/eval.ts`.
 * Jejich jména byla v tikové cestě — pravidlo tedy *četlo, jako by je pokrývalo* —
 * ale ze skenovaných modulů o nich nepřišel jediný záznam, takže `.every` a
 * `.some` nad operandy vstupního dokumentu procházely bez povšimnutí. Skenovaná
 * množina je proto `src/sim/` **sjednocené s tranzitivním uzávěrem importů**
 * z kořene tikové cesty, a nepokrytí se hlásí strukturálně přes
 * `undeclaredTickNames`: tikové jméno bez nalezené deklarace test shodí.
 *
 * **Co pravidlo NEPOKRÝVÁ, a je to tu napsané, ne zamlčené.** Policuje explicitní
 * iterační konstrukce a pole-callbacky. Zůstávají tři implicitní iterace, všechny
 * ohraničené jinde: `runtime.state.slice()` (délka je layout postavený
 * z deklarovaných slotů a entit), `new Set(runtime.drainQueue)` (každý `push` do
 * fronty má před sebou test proti `maxQueueDepth`, jinak je to `queue-overflow`)
 * a `.includes()` nad **modulovými konstantami** v `ir/schema.ts`
 * (`BOOLEAN_SPACES`, `ASSIGNABLE_SPACES` — jejich délka je pevná v době překladu
 * a vstupní dokument ji nezvětší, což je přesně to, co pravidlo hlídá). Kdyby
 * některá z těch mezí zmizela, tohle pravidlo to neuvidí.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

const SRC_DIR = join(process.cwd(), 'src');

/** Modul, ve kterém je deklarovaná `step()`. Odsud se počítá uzávěr importů. */
export const TICK_ROOTS = ['sim/interpreter.ts'] as const;

/** Adresář, který se skenuje celý, i mimo tikovou cestu. */
const SIM_PREFIX = 'sim/';

/** Pole `IrLimits`. Mez smí pocházet odsud, ne z délky vstupního pole. */
const LIMIT_FIELDS = new Set([
  'maxEntities',
  'maxSlots',
  'maxRules',
  'maxRuleFiringsPerTick',
  'maxQueueDepth',
  'maxAgents',
  'memorySlotsPerAgent',
  'gridWidth',
  'gridHeight',
]);

/** Funkce, které mez z `IrLimits` odvozují. Jiný způsob, jak ji vyrobit, není. */
const BOUND_FUNCTIONS = new Set(['phaseBound', 'pairBound', 'settleItemBound', 'sightBound', 'pathBound']);

/**
 * Konstanty, které drží **totéž číslo jako zod schéma**. Jsou třetím povoleným
 * původem meze vedle `IrLimits` a rozpočtu: dokument, který je překročí, se přes
 * schéma do runtimu nedostane, takže mez v podmínce smyčky je vynutitelná.
 * Sdílení se ověřuje vlastním testem — jinak by to bylo přejmenované magické
 * číslo, ne mez.
 */
const SCHEMA_BOUNDS = new Set(['MAX_OPERANDS']);

/** Iterace bez podmínky. Nemá kam mez napsat, takže je zakázaná na tikové cestě. */
const ARRAY_CALLBACKS = new Set([
  'forEach',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'flatMap',
  'reduce',
  'reduceRight',
  'sort',
]);

/**
 * Volaná jména, která nejsou funkce projektu. Pinuté a krátké schválně: každé
 * jméno na tikové cestě musí mít buď deklaraci ve skenovaných modulech, nebo
 * záznam tady. Bez toho by šlo celý modul vypustit ze skenu prostě tím, že by se
 * přestal dohledávat, a pravidlo by o něm mlčelo.
 */
const HOST_CALLS = new Set(['Number', 'String', 'Boolean']);

export interface Site {
  readonly module: string;
  readonly fn: string;
  readonly line: number;
  readonly kind: string;
  readonly bounded: boolean;
}

export interface SwitchFact {
  readonly module: string;
  readonly fn: string;
  readonly line: number;
  /** Vyčerpanost, kterou ověří **překladač** — viz `switchExhaustive`. */
  readonly exhaustive: boolean;
}

export interface ModuleFacts {
  readonly sites: readonly Site[];
  readonly switches: readonly SwitchFact[];
  readonly calls: ReadonlyMap<string, ReadonlySet<string>>;
  readonly resetBudgetCallers: readonly string[];
  readonly declared: ReadonlySet<string>;
}

/**
 * Jméno funkce, ve které uzel leží. Rozpoznává i šipku přiřazenou do `const` —
 * kdyby ne, každá smyčka uvnitř takové funkce by se připsala `<module>`, tedy
 * mimo tikovou cestu, a tvrdá půlka pravidla by ji přestala vidět.
 */
function enclosingFunction(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent !== undefined &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    )
      return current.parent.name.text;
    current = current.parent;
  }
  return '<module>';
}

/**
 * Vyčerpanost, kterou **ověří překladač** — a uznává se jediný tvar:
 * `default: { const exhaustive: never = x; … }`. Nová varianta unie se do `never`
 * nepřiřadí a je to TS2322, tedy chyba překladu, ne konvence.
 *
 * **Druhý tvar tu byl a byl nesprávný** *(nález re-review, 12. 8. 2026)*: „žádný
 * `default`, každá větev vrací, funkce má nevoidový návratový typ" se opírá
 * o TS2366 („lacks ending return statement"), jenže ten nevznikne, když za
 * přepínačem stojí jediný další `return`, ani když návratový typ obsahuje
 * `undefined`. Obojí je běžný způsob, jak se píše **částečný** přepínač, takže
 * pravidlo hlásilo „ověřeno překladačem" o kódu, který překladač nekontroluje.
 * Místo záplaty na heuristiku dostaly tři přepínače v `ir/eval.ts` `never` větev
 * — stejnou, jakou má zbytek projektu.
 */
function switchExhaustive(node: ts.SwitchStatement, sf: ts.SourceFile): boolean {
  const fallback = node.caseBlock.clauses.find((clause) => ts.isDefaultClause(clause));
  return fallback !== undefined && /:\s*never\b/.test(fallback.getText(sf));
}

/** Analýza jednoho modulu. Bere text, ne cestu, aby šla pustit na syntetický zdroj. */
export function analyseModule(moduleName: string, source: string): ModuleFacts {
  const sf = ts.createSourceFile(moduleName, source, ts.ScriptTarget.ES2022, true);
  const sites: Site[] = [];
  const switches: SwitchFact[] = [];
  const calls = new Map<string, Set<string>>();
  const resetBudgetCallers: string[] = [];
  const declared = new Set<string>();
  const scopes: Map<string, ts.Expression>[] = [new Map()];

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const lookup = (name: string): ts.Expression | undefined => {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const hit = scopes[i].get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  /**
   * Kolik atomů odvozených z deklarovaných mezí výraz obsahuje. Není to boolean
   * schválně: `const bound = 5` je taky statická mez, ale ne mez SVĚTA, a tenhle
   * rozdíl je celý smysl pravidla.
   */
  const limitAtoms = (node: ts.Node, depth: number): number => {
    if (depth > 8) return 0;
    if (ts.isParenthesizedExpression(node)) return limitAtoms(node.expression, depth + 1);
    if (ts.isPropertyAccessExpression(node)) return LIMIT_FIELDS.has(node.name.text) ? 1 : 0;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      return BOUND_FUNCTIONS.has(node.expression.text) ? 1 : 0;
    if (ts.isBinaryExpression(node)) return limitAtoms(node.left, depth + 1) + limitAtoms(node.right, depth + 1);
    if (ts.isPrefixUnaryExpression(node)) return limitAtoms(node.operand, depth + 1);
    if (ts.isIdentifier(node)) {
      if (SCHEMA_BOUNDS.has(node.text)) return 1;
      const declaredAs = lookup(node.text);
      return declaredAs ? limitAtoms(declaredAs, depth + 1) : 0;
    }
    return 0;
  };

  /**
   * Kolik členů výrazu **není** ani mez, ani číselná konstanta.
   *
   * Bez tohohle by stačil jeden atom kdekoli: `i < limits.maxSlots +
   * doc.ir.slots.length` má mez v podmínce, váže řídicí proměnnou a přesto roste
   * se vstupním dokumentem *(nález re-review, 12. 8. 2026)*. Mez tedy musí být
   * čistá — aritmetika nad `IrLimits` a konstantami ano, jakýkoli jiný člen ne.
   * Neznámý identifikátor (parametr funkce) se počítá jako cizí schválně: o jeho
   * hodnotě pravidlo nic neví.
   */
  const foreignAtoms = (node: ts.Node, depth: number): number => {
    if (depth > 8) return 1;
    if (ts.isParenthesizedExpression(node)) return foreignAtoms(node.expression, depth + 1);
    if (ts.isNumericLiteral(node)) return 0;
    if (ts.isPropertyAccessExpression(node)) return LIMIT_FIELDS.has(node.name.text) ? 0 : 1;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      return ts.isIdentifier(callee) && BOUND_FUNCTIONS.has(callee.text) ? 0 : 1;
    }
    if (ts.isBinaryExpression(node))
      return foreignAtoms(node.left, depth + 1) + foreignAtoms(node.right, depth + 1);
    if (ts.isPrefixUnaryExpression(node)) return foreignAtoms(node.operand, depth + 1);
    if (ts.isIdentifier(node)) {
      if (SCHEMA_BOUNDS.has(node.text)) return 0;
      const declaredAs = lookup(node.text);
      return declaredAs ? foreignAtoms(declaredAs, depth + 1) : 1;
    }
    return 1;
  };

  /** Mez je výraz nad deklarovanými mezemi a **ničím jiným**. */
  const limitDerived = (node: ts.Node): boolean => limitAtoms(node, 0) > 0 && foreignAtoms(node, 0) === 0;

  /** Rozloží podmínku na konjunkty — mez musí být v jednom z nich, ne kdekoli. */
  const conjuncts = (expr: ts.Expression): ts.Expression[] => {
    if (ts.isParenthesizedExpression(expr)) return conjuncts(expr.expression);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return [...conjuncts(expr.left), ...conjuncts(expr.right)];
    return [expr];
  };

  /** `<` a `<=` váží levou stranu, `>` a `>=` pravou. Jiné operátory nevážou nic. */
  const orientation = (kind: ts.SyntaxKind): 'left' | 'right' | null => {
    if (kind === ts.SyntaxKind.LessThanToken || kind === ts.SyntaxKind.LessThanEqualsToken) return 'left';
    if (kind === ts.SyntaxKind.GreaterThanToken || kind === ts.SyntaxKind.GreaterThanEqualsToken) return 'right';
    return null;
  };

  /**
   * Mez OMEZUJE řídicí proměnnou, nestačí, že se v podmínce vyskytuje.
   *
   * `for (let i = 0; i < doc.slots.length && limits.maxSlots > 0; i += 1)` má
   * v podmínce jméno meze a přesto iteruje přes vstupní dokument. Proto se hledá
   * porovnání, jehož **jedna strana je řídicí proměnná** a druhá je výraz nad
   * deklarovanými mezemi — a strany musí sedět na orientaci operátoru.
   */
  const boundsControl = (conjunct: ts.Expression, controls: ReadonlySet<string>): boolean => {
    if (!ts.isBinaryExpression(conjunct)) return false;
    const side = orientation(conjunct.operatorToken.kind);
    if (side === null) return false;
    const control = side === 'left' ? conjunct.left : conjunct.right;
    const bound = side === 'left' ? conjunct.right : conjunct.left;
    if (!ts.isIdentifier(control) || !controls.has(control.text)) return false;
    return limitDerived(bound);
  };

  const isBudgetRemaining = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'remaining' &&
    node.expression.getText(sf).includes('budget');

  /** Rozpočet se musí POROVNÁVAT, ne jen zmínit. */
  const budgetComparison = (conjunct: ts.Expression): boolean => {
    if (!ts.isBinaryExpression(conjunct)) return false;
    if (orientation(conjunct.operatorToken.kind) === null) return false;
    return isBudgetRemaining(conjunct.left) || isBudgetRemaining(conjunct.right);
  };

  /** …a tělo z něj musí ODEČÍTAT, jinak porovnání nikdy nepřestane platit. */
  const decrementsBudget = (body: ts.Node): boolean => {
    let found = false;
    const visitBody = (inner: ts.Node): void => {
      if (
        ts.isBinaryExpression(inner) &&
        inner.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken &&
        isBudgetRemaining(inner.left)
      )
        found = true;
      if (
        (ts.isPostfixUnaryExpression(inner) || ts.isPrefixUnaryExpression(inner)) &&
        inner.operator === ts.SyntaxKind.MinusMinusToken &&
        isBudgetRemaining(inner.operand)
      )
        found = true;
      ts.forEachChild(inner, visitBody);
    };
    visitBody(body);
    return found;
  };

  const budgetForm = (condition: ts.Expression, body: ts.Statement): boolean =>
    conjuncts(condition).filter(budgetComparison).length > 0 && decrementsBudget(body);

  /** Řídicí proměnné `for`: deklarované v hlavičce a měněné v inkrementoru. */
  const controlVariables = (node: ts.ForStatement): Set<string> => {
    const names = new Set<string>();
    const init = node.initializer;
    if (init !== undefined && ts.isVariableDeclarationList(init))
      for (const decl of init.declarations) if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
    const inc = node.incrementor;
    if (inc !== undefined) {
      const visitInc = (inner: ts.Node): void => {
        if (ts.isBinaryExpression(inner) && ts.isIdentifier(inner.left)) names.add(inner.left.text);
        if (
          (ts.isPostfixUnaryExpression(inner) || ts.isPrefixUnaryExpression(inner)) &&
          ts.isIdentifier(inner.operand)
        )
          names.add(inner.operand.text);
        ts.forEachChild(inner, visitInc);
      };
      visitInc(inc);
    }
    return names;
  };

  const forBounded = (node: ts.ForStatement): boolean => {
    const condition = node.condition;
    if (condition === undefined) return false;
    const controls = controlVariables(node);
    if (conjuncts(condition).filter((part) => boundsControl(part, controls)).length > 0) return true;
    return budgetForm(condition, node.statement);
  };

  const push = (node: ts.Node, kind: string, bounded: boolean) => {
    sites.push({ module: moduleName, fn: enclosingFunction(node), line: lineOf(node), kind, bounded });
  };

  const visit = (node: ts.Node): void => {
    const opensScope =
      ts.isBlock(node) || ts.isSourceFile(node) || ts.isForStatement(node) || ts.isCaseBlock(node);
    if (opensScope) scopes.push(new Map());

    if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        scopes[scopes.length - 1].set(decl.name.text, decl.initializer);
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          declared.add(decl.name.text);
      }
    }

    if (ts.isForStatement(node)) push(node, 'for', forBounded(node));
    else if (ts.isWhileStatement(node)) push(node, 'while', budgetForm(node.expression, node.statement));
    else if (ts.isDoStatement(node)) push(node, 'do', budgetForm(node.expression, node.statement));
    else if (ts.isForOfStatement(node)) push(node, 'for-of', false);
    else if (ts.isForInStatement(node)) push(node, 'for-in', false);
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ARRAY_CALLBACKS.has(node.expression.name.text)
    )
      push(node, `callback:${node.expression.name.text}`, false);

    if (ts.isSwitchStatement(node)) {
      switches.push({
        module: moduleName,
        fn: enclosingFunction(node),
        line: lineOf(node),
        exhaustive: switchExhaustive(node, sf),
      });
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const caller = enclosingFunction(node);
      if (!calls.has(caller)) calls.set(caller, new Set());
      calls.get(caller)?.add(node.expression.text);
      if (node.expression.text === 'resetBudget') resetBudgetCallers.push(caller);
    }

    ts.forEachChild(node, visit);
    if (opensScope) scopes.pop();
  };

  visit(sf);
  return { sites, switches, calls, resetBudgetCallers, declared };
}

// ---------------------------------------------------------------------------
// Skenovaná množina modulů
// ---------------------------------------------------------------------------

const pathOf = (moduleName: string) => join(SRC_DIR, ...moduleName.split('/'));
const sourceOf = (moduleName: string) => readFileSync(pathOf(moduleName), 'utf8');

/** `.ts` i `.tsx`, rekurzivně — obojí je díra, kterou kolo 4 review T8b našlo. */
function walkModules(prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(pathOf(prefix.replace(/\/$/, '')), { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__fixtures__') continue;
      found.push(...walkModules(`${rel}/`));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * Rozpuštění relativního importu na modul pod `src/`. Nerozpuštěný import se
 * **zamlčet nedá** — jeho funkce pak nemají deklaraci a `undeclaredTickNames`
 * spadne.
 */
function resolveRelative(from: string, spec: string): string | null {
  const stack: string[] = [];
  for (const part of [...from.split('/').slice(0, -1), ...spec.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const base = stack.join('/');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(pathOf(candidate))) return candidate;
  }
  return null;
}

function importsOf(moduleName: string, source: string): string[] {
  const sf = ts.createSourceFile(moduleName, source, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    const resolved = resolveRelative(moduleName, spec);
    if (resolved !== null) found.push(resolved);
  }
  return found;
}

/** Tranzitivní uzávěr importů z kořenů tikové cesty. */
function importClosure(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of importsOf(current, sourceOf(current))) queue.push(next);
  }
  return [...seen];
}

/** `src/sim/` sjednocené s uzávěrem importů z tikového kořene. */
export const SCANNED: readonly string[] = [
  ...new Set([...walkModules(SIM_PREFIX), ...importClosure(TICK_ROOTS)]),
].sort();

export function analyseAll(modules: readonly string[]): ModuleFacts {
  const sites: Site[] = [];
  const switches: SwitchFact[] = [];
  const calls = new Map<string, Set<string>>();
  const resetBudgetCallers: string[] = [];
  const declared = new Set<string>();
  for (const moduleName of modules) {
    const facts = analyseModule(moduleName, sourceOf(moduleName));
    sites.push(...facts.sites);
    switches.push(...facts.switches);
    resetBudgetCallers.push(...facts.resetBudgetCallers);
    for (const name of facts.declared) declared.add(name);
    for (const [caller, callees] of facts.calls) {
      if (!calls.has(caller)) calls.set(caller, new Set());
      for (const callee of callees) calls.get(caller)?.add(callee);
    }
  }
  return { sites, switches, calls, resetBudgetCallers, declared };
}

/**
 * Tiková cesta = tranzitivní uzávěr volání z `step()`. Rozsah pravidla se tím
 * **počítá**, ne ručně vypisuje: kdyby se zítra dostala konstrukční funkce do
 * tiku, spadne pod tvrdou půlku pravidla sama.
 */
export function tickPath(calls: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const reached = new Set<string>(['step']);
  const queue = ['step'];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const callee of calls.get(current) ?? []) {
      if (reached.has(callee)) continue;
      reached.add(callee);
      queue.push(callee);
    }
  }
  return reached;
}

/**
 * Jména na tikové cestě, o kterých sken nic neví. Neprázdný výsledek znamená, že
 * tik volá kód, který pravidlo nikdy nepřečetlo — tedy přesně ta vada, kterou
 * mělo policovat.
 */
export function undeclaredTickNames(declared: ReadonlySet<string>, path: ReadonlySet<string>): string[] {
  return [...path].filter((fn) => !declared.has(fn) && !HOST_CALLS.has(fn)).sort();
}
