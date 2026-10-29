import { createRequire } from 'node:module';
import type ParserT from 'tree-sitter';
import { AnalyzerError } from '../errors.js';
import type {
  CodeChunk,
  ParsedFile,
  ParsedSymbol,
  RawImport,
  SourceFile,
  SymbolKind,
} from '../types.js';
import { extOf } from './lang.js';
import { IMPORT_QUERY, SYMBOL_QUERY } from './queries.js';
import { recoverChunks, splitClass } from './chunking.js';

type SyntaxNode = ParserT.SyntaxNode;
// 原生绑定是 CJS,在 ESM 包里用 createRequire 加载;加载失败统一包装成 PARSER_UNAVAILABLE
const require = createRequire(import.meta.url);

interface Grammar {
  lang: unknown;
  imports: ParserT.Query;
  symbols: ParserT.Query;
}

let cached: { Parser: typeof ParserT; ts: Grammar; tsx: Grammar } | null = null;

function load() {
  if (cached) return cached;
  try {
    const Parser = require('tree-sitter') as typeof ParserT;
    const langs = require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
    const mk = (lang: unknown): Grammar => ({
      lang,
      imports: new Parser.Query(lang as ParserT.Language, IMPORT_QUERY),
      symbols: new Parser.Query(lang as ParserT.Language, SYMBOL_QUERY),
    });
    cached = { Parser, ts: mk(langs.typescript), tsx: mk(langs.tsx) };
    return cached;
  } catch (err) {
    throw new AnalyzerError('PARSER_UNAVAILABLE', `tree-sitter 原生绑定加载失败: ${String(err)}`);
  }
}

const hasTypeKeyword = (n: SyntaxNode): boolean => n.children.some((c) => c.type === 'type');

/** `import type X` 或所有具名导入都带 `type` 修饰时视为 type-only */
function isTypeOnlyImport(stmt: SyntaxNode): boolean {
  if (hasTypeKeyword(stmt)) return true;
  const clause = stmt.children.find((c) => c.type === 'import_clause');
  if (!clause) return false; // `import './side-effect'`
  if (clause.namedChildren.some((c) => c.type !== 'named_imports')) return false; // 有 default/namespace
  const specs = clause.namedChildren.flatMap((c) =>
    c.namedChildren.filter((s) => s.type === 'import_specifier'),
  );
  return specs.length > 0 && specs.every(hasTypeKeyword);
}

const SYMBOL_KINDS = new Set<SymbolKind>([
  'function',
  'class',
  'method',
  'interface',
  'type',
  'var',
]);

function isExported(decl: SyntaxNode): boolean {
  let n: SyntaxNode | null = decl.parent;
  // variable_declarator → lexical_declaration → export_statement
  for (let i = 0; n && i < 2; i++, n = n.parent) {
    if (n.type === 'export_statement') return true;
    if (n.type !== 'lexical_declaration' && n.type !== 'variable_declaration') break;
  }
  return false;
}

function collectExports(root: SyntaxNode): string[] {
  const out: string[] = [];
  for (const st of root.namedChildren) {
    if (st.type !== 'export_statement') continue;
    if (st.children.some((c) => c.type === 'default')) {
      out.push('default');
      continue;
    }
    const decl = st.childForFieldName('declaration');
    if (decl) {
      const declarators = decl.namedChildren.filter((c) => c.type === 'variable_declarator');
      const names = declarators.length
        ? declarators.map((d) => d.childForFieldName('name')?.text)
        : [decl.childForFieldName('name')?.text];
      for (const nm of names) if (nm) out.push(nm);
      continue;
    }
    const ns = st.namedChildren.find((c) => c.type === 'namespace_export');
    if (ns) {
      out.push(ns.namedChildren[0]?.text ?? '*');
      continue;
    }
    const clause = st.namedChildren.find((c) => c.type === 'export_clause');
    if (clause) {
      for (const s of clause.namedChildren) {
        const nm = (s.childForFieldName('alias') ?? s.childForFieldName('name'))?.text;
        if (nm) out.push(nm);
      }
      continue;
    }
    if (st.childForFieldName('source')) out.push('*'); // export * from
  }
  return [...new Set(out)];
}

function timedOutResult(file: SourceFile): ParsedFile {
  const loc = file.content.length ? file.content.split('\n').length : 0;
  return {
    path: file.path,
    loc,
    imports: [],
    symbols: [],
    exports: [],
    chunks: [{ symbol: null, startLine: 1, endLine: Math.max(1, loc) }],
    hasSyntaxError: false,
    timedOut: true,
  };
}

/**
 * Tree-sitter 层:只做语法级抽取(import 说明符与 kind、符号与行号、导出名、切块)。
 * 不解析路径 —— 路径解析交给 ts-morph(或降级的前缀替换)。
 */
export interface ParseOptions {
  /** 单文件解析超时(毫秒),0 表示不限;超时返回 timedOut=true 的空结果 */
  timeoutMs?: number;
}

export function parseWithTreeSitter(file: SourceFile, opts: ParseOptions = {}): ParsedFile {
  const g = load();
  const ext = extOf(file.path);
  const grammar =
    ext === '.tsx' || ext === '.jsx' || ext === '.js' || ext === '.mjs' || ext === '.cjs'
      ? g.tsx
      : g.ts;
  const parser = new g.Parser();
  parser.setLanguage(grammar.lang as ParserT.Language);
  if (opts.timeoutMs) parser.setTimeoutMicros(Math.round(opts.timeoutMs * 1000));
  // 原生绑定默认缓冲区较小,大文件需显式放大 bufferSize,否则会抛 Invalid argument
  const tree = parser.parse(file.content, undefined, {
    bufferSize: Math.max(32 * 1024, file.content.length * 2 + 1024),
  }) as ParserT.Tree | null | undefined;
  // 超时时原生绑定返回空树(rootNode 缺失)或 null
  if (!tree || !tree.rootNode) return timedOutResult(file);
  const root = tree.rootNode;

  const imports: RawImport[] = [];
  for (const m of grammar.imports.matches(root)) {
    const spec = m.captures.find((c) => c.name === 'spec')?.node;
    const outer = m.captures.find((c) => c.name !== 'spec' && c.name !== '_fn');
    if (!spec || !outer) continue;
    let kind: RawImport['kind'];
    if (outer.name === 'import') kind = isTypeOnlyImport(outer.node) ? 'type-only' : 'static';
    else if (outer.name === 'reexport') kind = 're-export';
    else if (outer.name === 'dynamic') kind = 'dynamic';
    else kind = 'require';
    imports.push({ spec: spec.text, kind, line: spec.startPosition.row + 1 });
  }

  const symbols: ParsedSymbol[] = [];
  const classNodes = new Map<ParsedSymbol, SyntaxNode>();
  for (const m of grammar.symbols.matches(root)) {
    const name = m.captures.find((c) => c.name === 'name')?.node;
    const decl = m.captures.find((c) => c.name !== 'name');
    if (!name || !decl || !SYMBOL_KINDS.has(decl.name as SymbolKind)) continue;
    const node = decl.node;
    // var 只收顶层声明(含 export),局部变量不是符号
    if (decl.name === 'var') {
      const stmt = node.parent;
      const top = stmt?.parent;
      if (
        !top ||
        !(
          top.type === 'program' ||
          (top.type === 'export_statement' && top.parent?.type === 'program')
        )
      )
        continue;
    }
    const value = node.childForFieldName('value');
    const kind: SymbolKind =
      decl.name === 'var' &&
      value &&
      (value.type === 'arrow_function' || value.type === 'function_expression')
        ? 'function'
        : (decl.name as SymbolKind);
    const sym: ParsedSymbol = {
      name: name.text,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
    };
    symbols.push(sym);
    if (kind === 'class') classNodes.set(sym, node);
  }

  const loc = file.content.length === 0 ? 0 : file.content.split('\n').length;
  // 切块(版本见 @repolens/shared CHUNKER_VERSION):顶层声明一块;大类按方法拆块(chunking.ts);
  // 语法树出错时按顶层声明起始行兜底;没有声明时整文件一块
  let chunks: CodeChunk[] = symbols
    .filter((s) => s.kind !== 'method')
    .flatMap((s) => {
      const node = classNodes.get(s);
      const split = node ? splitClass(node, s.name) : null;
      return split ?? [{ symbol: s.name, startLine: s.startLine, endLine: s.endLine }];
    });
  if (root.hasError) chunks = recoverChunks(root, file.content, chunks);
  if (chunks.length === 0 && loc > 0) chunks.push({ symbol: null, startLine: 1, endLine: loc });

  return {
    path: file.path,
    loc,
    imports,
    symbols,
    exports: collectExports(root),
    chunks,
    hasSyntaxError: root.hasError,
  };
}
