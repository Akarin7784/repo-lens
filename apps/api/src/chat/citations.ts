import { fileId, type Citation } from '@repolens/shared';
import type { Snippet } from './prompt.js';

export type CitationOutput =
  { type: 'token'; text: string } | { type: 'citation'; citation: Citation };

/*
 * 标记规则(架构师裁定,见 ARCHITECTURE §4.2):
 * 1. 合法:[[S<数字>:<数字>]] 与 [[S<数字>:<数字>-<数字>]],单行按 a-a;
 * 2. 以 [[S<数字>: 开头、其后只有数字/冒号/连字符/字母、以 ]] 结尾但不符合 1 的
 *    (如 [[S1:]]、[[S1:a-b]]、[[S1:3-]]):剔除文本、不发 citation、计入 dropped;
 *    不以 [[S<数字>: 开头的([[x]]、[[0]]、arr[0]、m[[1]])原样当文本;
 * 3. 半截标记:结尾是 [[S<数字>:<数字和连字符> 加最多一个 ] 时缓冲到下一个 token;
 *    缓冲超过 24 个字符或出现不属于标记的字符就当文本输出。
 */
const MARKER = /^\[\[S(\d+):(\d+)(?:-(\d+))?\]\]/;
const MALFORMED = /^\[\[S\d+:[0-9A-Za-z:-]*\]\]/;
const PARTIAL = /^\[(?:\[(?:S(?:\d+(?::[\d-]*\]?)?)?)?)?$/;
const MAX_PENDING = 24;

/**
 * 流式引用解析 + 校验(纯逻辑,无 IO)。
 * - 从 token 文本中去掉合法标记,在标记原位置之后产出 citation;
 * - 范围收缩到与片段 Sn 的交集,无交集 / 未知 Sn / a>b / 行号 0 则剔除(只去文本,不产出事件);
 * - citation.id 是显示编号,按 (path, 收缩后范围) 首次出现从 1 分配,重复出现沿用 id 但每次都产出事件;
 * - 模型输出的路径从不使用,path/nodeId 只取自片段。
 */
export class CitationStream {
  private pending = '';
  private readonly ids = new Map<string, number>();
  private readonly byN: Map<number, Snippet>;
  /**
   * 被剔除的标记数(范围无效 + 格式不合法)。P4 接 done.droppedCitations 时直接读取,
   * 不改这个公开字段的名字和语义;外部只读。
   */
  private droppedCount = 0;
  get dropped(): number {
    return this.droppedCount;
  }

  constructor(snippets: readonly Snippet[]) {
    this.byN = new Map(snippets.map((s) => [s.n, s]));
  }

  push(text: string): CitationOutput[] {
    this.pending += text;
    return this.drain(false);
  }

  /** 流结束:残留的半截标记按普通文本输出 */
  end(): CitationOutput[] {
    return this.drain(true);
  }

  private drain(final: boolean): CitationOutput[] {
    const out: CitationOutput[] = [];
    let text = '';
    let s = this.pending;
    for (;;) {
      const i = s.indexOf('[');
      if (i < 0) {
        text += s;
        s = '';
        break;
      }
      text += s.slice(0, i);
      s = s.slice(i);
      const m = MARKER.exec(s);
      if (m) {
        if (text) out.push({ type: 'token', text });
        text = '';
        const c = this.validate(Number(m[1]), Number(m[2]), Number(m[3] ?? m[2]));
        if (c) out.push({ type: 'citation', citation: c });
        else this.droppedCount++;
        s = s.slice(m[0].length);
        continue;
      }
      const bad = MALFORMED.exec(s);
      if (bad) {
        if (text) out.push({ type: 'token', text });
        text = '';
        this.droppedCount++;
        s = s.slice(bad[0].length);
        continue;
      }
      if (!final && s.length <= MAX_PENDING && PARTIAL.test(s)) break;
      text += '[';
      s = s.slice(1);
    }
    if (text) out.push({ type: 'token', text });
    this.pending = s;
    return out;
  }

  private validate(n: number, a: number, b: number): Citation | null {
    const sn = this.byN.get(n);
    if (!sn || a < 1 || b < 1 || a > b) return null;
    const lo = Math.max(a, sn.startLine);
    const hi = Math.min(b, sn.endLine);
    if (lo > hi) return null;
    const key = `${sn.path}\0${lo}-${hi}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(key, id);
    }
    const c: Citation = { id, path: sn.path, startLine: lo, endLine: hi, nodeId: fileId(sn.path) };
    if (sn.moduleId) c.moduleId = sn.moduleId;
    return c;
  }
}
