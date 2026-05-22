// Local ESLint rules for keeping Turbopack's NFT analyzer happy.
//
// Background: Turbopack/`@vercel/nft` runs static analysis on every `fs.*`
// call to figure out which files each serverless function needs at runtime.
// When the first argument is a string literal it can answer precisely; when
// the first argument is a variable it defaults to "include everything under
// the containing directory" — which has, in this repo, resulted in 175k
// files traced per route, 1.4 GB of NFT JSON output, and a build worker
// pegged at 485 % CPU + 471 GB virtual memory.
//
// The escape hatch is a magic comment immediately before the dynamic arg:
//   existsSync(/*turbopackIgnore: true*/ p)
// Statically-scoped joins like `join(process.cwd(), 'data', 'foo.json')` are
// fine and need no annotation.
//
// This rule errors on any `fs` (or `node:fs`/`fs/promises`) call whose first
// arg is dynamic AND lacks the `turbopackIgnore` block comment. It also
// recognises common dynamic patterns we know are safe (file descriptors
// produced by `openSync`/etc., which NFT doesn't trace) so the rule doesn't
// fire on `fstatSync(fd)` or `readSync(fd, …)`.

// File-system call sites we want to police. These are the calls Turbopack's
// static analysis traces. `f*Sync(fd, …)` variants operate on already-open
// file descriptors and don't take a path, so they're excluded.
const PATH_TAKING_FS_FUNCTIONS = new Set([
  'existsSync',
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'open',
  'openSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'mkdir',
  'mkdirSync',
  'rmdir',
  'rmdirSync',
  'rm',
  'rmSync',
  'copyFile',
  'copyFileSync',
  'watch',
  'watchFile',
  'chmod',
  'chmodSync',
  'access',
  'accessSync',
  'realpath',
  'realpathSync',
]);

// Magic comment the Turbopack analyzer recognizes. Must be a block comment,
// adjacent to the offending argument.
const TURBOPACK_IGNORE_RE = /turbopackIgnore:\s*true/;
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const FD_ACCEPTING_FS_FUNCTIONS = new Set([
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
]);

/**
 * Resolve the callee's filesystem function name when the call is either a
 * tracked bare import (`readFile(...)`) or a tracked namespace call
 * (`fs.readFile(...)`).
 * Returns null for anything we don't recognise.
 */
function fsFnNameOf(node, fsNamedImports, fsNamespaces) {
  if (node.type === 'Identifier') return fsNamedImports.get(node.name) ?? null;
  if (node.type === 'MemberExpression' && !node.computed) {
    if (
      node.object.type === 'Identifier' &&
      fsNamespaces.has(node.object.name) &&
      node.property.type === 'Identifier'
    ) {
      return node.property.name;
    }
  }
  return null;
}

function importedName(specifier) {
  if (specifier.imported?.type === 'Identifier') return specifier.imported.name;
  if (specifier.imported?.type === 'Literal') return specifier.imported.value;
  return null;
}

function addFsImportBindings(node, fsNamedImports, fsNamespaces) {
  if (!FS_MODULES.has(node.source.value)) return;
  for (const specifier of node.specifiers) {
    if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
      fsNamespaces.add(specifier.local.name);
      continue;
    }
    if (specifier.type !== 'ImportSpecifier') continue;
    const name = importedName(specifier);
    if (typeof name === 'string' && PATH_TAKING_FS_FUNCTIONS.has(name)) {
      fsNamedImports.set(specifier.local.name, name);
    }
  }
}

function addFsRequireBindings(node, fsNamedImports, fsNamespaces) {
  if (node.id?.type !== 'Identifier' && node.id?.type !== 'ObjectPattern') return;
  if (node.init?.type !== 'CallExpression') return;
  if (node.init.callee.type !== 'Identifier' || node.init.callee.name !== 'require') return;
  const source = node.init.arguments[0];
  if (source?.type !== 'Literal' || !FS_MODULES.has(source.value)) return;

  if (node.id.type === 'Identifier') {
    fsNamespaces.add(node.id.name);
    return;
  }

  for (const prop of node.id.properties) {
    if (prop.type !== 'Property') continue;
    const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
    if (typeof key !== 'string' || !PATH_TAKING_FS_FUNCTIONS.has(key)) continue;
    if (prop.value.type === 'Identifier') {
      fsNamedImports.set(prop.value.name, key);
    }
  }
}

/** A first arg counts as "static" — and therefore safe for NFT — when it's
 *  a string literal, a template literal with no interpolations, or a
 *  statically-scoped `join(...)` whose first segment is a known anchor
 *  (`process.cwd()`, `__dirname`, `import.meta.dirname`). Anything else is
 *  treated as dynamic. */
function isStaticPathArg(arg) {
  if (!arg) return true; // no arg at all → not our concern
  if (arg.type === 'Literal' && typeof arg.value === 'string') return true;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) return true;
  if (arg.type === 'CallExpression') {
    // join(...), resolve(...), path.join(...), path.resolve(...)
    const callee = arg.callee;
    let name = null;
    if (callee.type === 'Identifier') name = callee.name;
    else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') name = callee.property.name;
    if (name === 'join' || name === 'resolve') {
      // First arg of join/resolve is the anchor.
      const first = arg.arguments[0];
      if (!first) return true;
      if (first.type === 'Literal' && typeof first.value === 'string' && first.value.startsWith('/')) return true;
      if (first.type === 'Identifier' && (first.name === '__dirname' || first.name === '__filename')) return true;
      if (first.type === 'CallExpression') {
        const inner = first.callee;
        if (inner.type === 'MemberExpression' && inner.object.type === 'Identifier' && inner.object.name === 'process' && inner.property.type === 'Identifier' && inner.property.name === 'cwd') return true;
      }
      if (first.type === 'MemberExpression') {
        // import.meta.dirname / import.meta.url
        const obj = first.object;
        if (obj.type === 'MetaProperty' && obj.meta?.name === 'import' && obj.property?.name === 'meta') return true;
      }
    }
  }
  // Identifiers, member expressions, binary expressions, calls returning
  // dynamic values — all dynamic from NFT's point of view.
  return false;
}

/** True when there's a block comment matching `turbopackIgnore: true`
 *  immediately attached to the first argument. ESLint surfaces this via
 *  `sourceCode.getCommentsBefore(arg)`. */
function hasTurbopackIgnoreComment(sourceCode, arg) {
  const comments = sourceCode.getCommentsBefore(arg);
  if (comments.some((c) => c.type === 'Block' && TURBOPACK_IGNORE_RE.test(c.value))) return true;
  if (!arg.range) return false;
  return sourceCode
    .getAllComments()
    .some((c) => c.type === 'Block' && c.range?.[0] >= arg.range[0] && c.range[1] <= arg.range[1] && TURBOPACK_IGNORE_RE.test(c.value));
}

function isLikelyFileDescriptorArg(fnName, arg) {
  if (!FD_ACCEPTING_FS_FUNCTIONS.has(fnName)) return false;
  if (arg.type === 'Literal' && typeof arg.value === 'number') return true;
  return arg.type === 'Identifier' && /(^fd$|Fd$|FD$)/.test(arg.name);
}

/** Rule: require-turbopack-ignore-on-dynamic-fs */
const requireTurbopackIgnoreOnDynamicFs = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `/*turbopackIgnore: true*/` on `fs.*` calls whose path argument is dynamic, so Turbopack/NFT doesn\'t balloon the per-route trace.',
    },
    messages: {
      missing:
        'Dynamic path passed to `{{ fn }}` — Turbopack/NFT will trace the whole containing directory and bloat the build. Annotate with `/*turbopackIgnore: true*/` (e.g. `{{ fn }}(/*turbopackIgnore: true*/ p)`), or refactor to a literal path. See docs/PROFILING.md.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const fsNamedImports = new Map();
    const fsNamespaces = new Set();
    return {
      ImportDeclaration(node) {
        addFsImportBindings(node, fsNamedImports, fsNamespaces);
      },
      VariableDeclarator(node) {
        addFsRequireBindings(node, fsNamedImports, fsNamespaces);
      },
      CallExpression(node) {
        const name = fsFnNameOf(node.callee, fsNamedImports, fsNamespaces);
        if (!name || !PATH_TAKING_FS_FUNCTIONS.has(name)) return;
        const firstArg = node.arguments[0];
        if (!firstArg) return;
        if (isLikelyFileDescriptorArg(name, firstArg)) return;
        if (isStaticPathArg(firstArg)) return;
        if (hasTurbopackIgnoreComment(sourceCode, firstArg)) return;
        context.report({ node: firstArg, messageId: 'missing', data: { fn: name } });
      },
    };
  },
};

export const rules = {
  'require-turbopack-ignore-on-dynamic-fs': requireTurbopackIgnoreOnDynamicFs,
};
