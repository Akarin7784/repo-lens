import type ParserT from 'tree-sitter';
import type { CodeChunk } from '../types.js';

type SyntaxNode = ParserT.SyntaxNode;

/** 类超过这么多行才按方法拆块;小类整块更利于检索上下文 */
export const CLASS_SPLIT_MIN_LINES = 40;

const MEMBER_FN = new Set(['arrow_function', 'function_expression']);

/**
 * 大类按方法拆块:类头(类声明起始到第一个方法之前,含字段)记为 `类名`,
 * 每个方法(含值为箭头函数/函数表达式的字段)记为 `类名.方法名`。
 * 不满足拆分条件时返回 null,调用方保留整类一块。
 */
export function splitClass(classNode: SyntaxNode, name: string): CodeChunk[] | null {
  const start = classNode.startPosition.row + 1;
  const end = classNode.endPosition.row + 1;
  if (end - start + 1 < CLASS_SPLIT_MIN_LINES) return null;
  const body = classNode.childForFieldName('body');
  if (!body) return null;
  const members: CodeChunk[] = [];
  for (const m of body.namedChildren) {
    let isFn = m.type === 'method_definition';
    if (m.type === 'public_field_definition') {
      const v = m.childForFieldName('value');
      isFn = !!v && MEMBER_FN.has(v.type);
    }
    const nm = m.childForFieldName('name')?.text;
    if (!isFn || !nm) continue;
    // 方法前紧邻的注释/装饰器一起算进方法块
    let s = m.startPosition.row + 1;
    for (let p = m.previousNamedSibling; p && p.type === 'comment'; p = p.previousNamedSibling) {
      if (p.endPosition.row + 1 < s - 1) break;
      s = p.startPosition.row + 1;
    }
    members.push({ symbol: `${name}.${nm}`, startLine: s, endLine: m.endPosition.row + 1 });
  }
  if (members.length < 2) return null;
  const headEnd = members[0]!.startLine - 1;
  const head: CodeChunk = { symbol: name, startLine: start, endLine: Math.max(start, headEnd) };
  return [head, ...members];
}

/** 顶层声明起始行(只认第 0 列,语法树出错时兜底用) */
const TOP_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;

const isCommentOrBlank = (l: string) => {
  const t = l.trim();
  return t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
};

/** 语法树里像样的顶层语句;其余(ERROR 及其碎片 type_parameters 等)视为出错区域 */
const isWellFormedTop = (n: SyntaxNode) =>
  !n.hasError &&
  (n.type === 'comment' || n.type.endsWith('_statement') || n.type.endsWith('_declaration'));

/**
 * 语法错误兜底:tree-sitter 对某些合法 TS(例如对象类型里换行分隔、以 `<` 开头的泛型调用签名)
 * 会产生 ERROR,且错误恢复可能吞掉其后的整段顶层声明,导致这些声明没有切块。
 * 这里用「第 0 列的顶层声明起始行」把出错区域重新切开:
 * - 起始行未被任何块覆盖的声明补一块,结束于下一个顶层声明前(去掉其间的空行与注释);
 * - 已有块若结束后紧接出错区域,延长到同样的边界(它的后半段被错误恢复截掉了)。
 * 没有出错区域时原样返回。
 */
export function recoverChunks(root: SyntaxNode, content: string, chunks: CodeChunk[]): CodeChunk[] {
  const bad = root.namedChildren
    .filter((n) => !isWellFormedTop(n))
    .map((n) => [n.startPosition.row + 1, n.endPosition.row + 1] as const);
  if (!bad.length) return chunks;
  const lines = content.split('\n');
  const starts = new Map<number, string>();
  lines.forEach((l, i) => {
    const m = TOP_DECL.exec(l);
    if (m) starts.set(i + 1, m[1]!);
  });
  for (const c of chunks) if (!c.symbol?.includes('.')) starts.set(c.startLine, c.symbol ?? '');
  const sorted = [...starts.keys()].sort((a, b) => a - b);
  const boundary = (s: number) => {
    const next = sorted.find((x) => x > s) ?? lines.length + 1;
    let e = next - 1;
    while (e > s && isCommentOrBlank(lines[e - 1] ?? '')) e--;
    return e;
  };
  const touchesBad = (from: number, to: number) => bad.some(([a, b]) => a <= to && b >= from);
  const covered = (ln: number) => chunks.some((c) => c.startLine <= ln && ln <= c.endLine);
  const out = chunks.map((c) => {
    if (c.symbol?.includes('.')) return c;
    const e = boundary(c.startLine);
    return e > c.endLine && touchesBad(c.endLine + 1, e) ? { ...c, endLine: e } : c;
  });
  for (const s of sorted) {
    if (covered(s)) continue;
    const e = boundary(s);
    if (touchesBad(s, e)) out.push({ symbol: starts.get(s) || null, startLine: s, endLine: e });
  }
  return out.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}
