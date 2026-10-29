import { fileId, type Citation } from '@repolens/shared';
import type { Snippet } from './prompt.js';

export type CitationOutput =
  { type: 'token'; text: string } | { type: 'citation'; citation: Citation };

const MARKER = /^\[\[S(\d+):(\d+)-(\d+)\]\]/;
/** 可能是标记前缀(还没收完)的尾巴;不匹配就当普通文本 */
const PARTIAL = /^\[(?:\[(?:S(?:\d+(?::(?:\d+(?:-(?:\d+(?:\]?)?)?)?)?)?)?)?)?$/;
/** 防止异常长的数字串一直卡在缓冲里 */
const MAX_PENDING = 64;

/**
 * 流式引用解析 + 校验(纯逻辑,无 IO)。
 * - 从 token 文本中去掉 [[Sn:a-b]],在标记原位置之后产出 citation;
 * - 范围收缩到与片段 Sn 的交集,无交集 / 未知 Sn / a>b / 行号 0 则剔除(只去文本,不产出事件);
 * - citation.id 是显示编号,按 (path, 收缩后范围) 首次出现从 1 分配,重复出现沿用 id 但每次都产出事件;
 * - 模型输出的路径从不使用,path/nodeId 只取自片段。
 */
export class CitationStream {
  private pending = '';
  private readonly ids = new Map<string, number>();
  private readonly byN: Map<number, Snippet>;
  dropped = 0;

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
        const c = this.validate(Number(m[1]), Number(m[2]), Number(m[3]));
        if (c) out.push({ type: 'citation', citation: c });
        else this.dropped++;
        s = s.slice(m[0].length);
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
