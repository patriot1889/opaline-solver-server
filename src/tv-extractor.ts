import { ServiceError } from './errors.js';

// ASTs belong to the vendored Meriyah/astring distribution. They never leave a worker.
type Node = any;
function walk(node: Node, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function integer(n: Node): number | undefined {
  if (n?.type === 'Literal' && Number.isSafeInteger(n.value)) return n.value;
  return undefined;
}

/** Expose TV's obfuscated URL factory in the shape maintained EJS recognizes.
 * No player id, minified symbol, string-table index or dispatcher key is pinned.
 * Only source-proven calls to a dispatcher setting alr=yes are eligible.
 */
export function exposeTVFactory(source: string, parser: any, generator: any): string {
  const program = parser.parse(source);
  const call = program.body[0]?.expression;
  const fn = call?.callee?.type === 'MemberExpression' ? call.callee.object : call?.callee;
  if (program.body.length !== 1 || fn?.type !== 'FunctionExpression') throw new ServiceError('unsupported_tv_player');
  const body: Node[] = fn.body.body;
  let tableName: string | undefined, table: string[] | undefined;
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const decl of statement.declarations) {
      const init = decl.init;
      if (init?.type === 'CallExpression' && init.callee?.property?.name === 'split' &&
          typeof init.callee.object?.value === 'string' && typeof init.arguments[0]?.value === 'string') {
        const values = init.callee.object.value.split(init.arguments[0].value);
        if (['alr', 'yes', 'set'].every(s => values.includes(s))) { table = values; tableName = decl.id.name; break; }
      }
    }
    if (table) break;
  }
  if (!table || !tableName) throw new ServiceError('unsupported_tv_player');
  function lookup(node: Node): { key: string; mask: number } | undefined {
    if (node?.type !== 'MemberExpression' || node.object?.name !== tableName || !node.computed) return;
    const p = node.property;
    if (p?.type === 'BinaryExpression' && p.operator === '^' && p.left?.type === 'Identifier' && integer(p.right) !== undefined)
      return { key: p.left.name, mask: p.right.value };
  }
  const dispatchers: { name: string; xor: number }[] = [];
  for (const statement of body) {
    const decls = statement.type === 'VariableDeclaration' ? statement.declarations : [];
    for (const decl of decls) {
      const f = decl.init;
      if (f?.type !== 'FunctionExpression' || f.params.length < 5) continue;
      walk(f.body, n => {
        if (n.type !== 'CallExpression' || n.arguments.length !== 2 || n.callee?.type !== 'MemberExpression') return;
        const method = lookup(n.callee.property), a = lookup(n.arguments[0]), b = lookup(n.arguments[1]);
        if (!method || !a || !b || method.key !== a.key || a.key !== b.key) return;
        const xor = a.mask ^ table!.indexOf('alr');
        if ((b.mask ^ xor) !== table!.indexOf('yes') || (method.mask ^ xor) !== table!.indexOf('set')) return;
        const proven = f.body.body.some((s: Node) => s.type === 'VariableDeclaration' && s.declarations.some((d: Node) =>
          d.id?.name === a.key && d.init?.type === 'BinaryExpression' && d.init.operator === '^' &&
          [d.init.left?.name, d.init.right?.name].sort().join('|') === [f.params[0]?.name, f.params[1]?.name].sort().join('|')));
        if (proven) dispatchers.push({ name: decl.id.name, xor });
      });
    }
  }
  const wrappers = new Set<string>();
  walk(program, n => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'Identifier') return;
    const a = integer(n.arguments[0]), b = integer(n.arguments[1]);
    if (a === undefined || b === undefined) return;
    for (const d of dispatchers) {
      if (n.callee.name !== d.name || (a ^ b) !== d.xor) continue;
      wrappers.add(`${d.name}(${a},${b},url,key,sig)`);
      if (wrappers.size > 8) throw new ServiceError('ambiguous_tv_player');
    }
  });
  if (!wrappers.size) throw new ServiceError('unsupported_tv_player');
  let i = 0;
  for (const expression of wrappers) body.push(...parser.parse(`function __opalineTV${i++}(url,key,sig){var result=${expression};result.set("alr","yes");return result;}`).body);
  return generator.generate(program);
}
