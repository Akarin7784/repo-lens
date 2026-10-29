import { createHash } from 'node:crypto';
import { exclusionRule } from '@repolens/shared';

/** 切块输入:analyzer 给出的顶层声明块(行号 1 起,闭区间) */
export interface ChunkSpan {
  symbol: string | null;
  startLine: number;
  endLine: number;
}
export interface ChunkSourceFile {
  path: string;
  chunks: ChunkSpan[];
  /** analyzer 已判定敏感时的规则 id */
  sensitive?: string;
}

export interface CodeChunkRecord {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  /** 送 embedding 的文本:`路径 符号\n代码`(不含 e5 前缀,前缀由 Embedder 加) */
  text: string;
  contentHash: string;
}

/** 单块文本上限(字符),防止超长声明撑大内存;e5 本身也只看前 512 token */
export const MAX_CHUNK_CHARS = 4000;

/**
 * 送 embedding 的文本模板版本:`${path} ${symbol}\n${code}` 截断到 MAX_CHUNK_CHARS,再由 Embedder
 * 加 E5 前缀(passage: / query: )。模板、截断长度或前缀任一改动都必须递增;它进 embedding digest。
 */
export const EMBED_TEXT_VERSION = 1;

export interface ChunkResult {
  chunks: CodeChunkRecord[];
  /** 被排除的文件及规则 id(sensitive / too-large / binary 等),只记规则不记内容 */
  excluded: { path: string; rule: string }[];
}

/**
 * 切块前用共享排除规则(exclusionRule:敏感路径/内容、超大、二进制)逐文件过滤,
 * 命中的文件一块都不产出,也就不会进 embedding 和向量库。
 * readSource 返回 null(读不到、符号链接等)时同样跳过。
 */
export async function buildChunks(
  files: ChunkSourceFile[],
  readSource: (path: string) => Promise<string | null>,
): Promise<ChunkResult> {
  const chunks: CodeChunkRecord[] = [];
  const excluded: ChunkResult['excluded'] = [];
  for (const f of files) {
    if (f.sensitive) {
      excluded.push({ path: f.path, rule: f.sensitive });
      continue;
    }
    if (!f.chunks.length) continue;
    const src = await readSource(f.path);
    if (src === null) {
      excluded.push({ path: f.path, rule: 'unreadable' });
      continue;
    }
    const rule = exclusionRule(f.path, src);
    if (rule) {
      excluded.push({ path: f.path, rule });
      continue;
    }
    const lines = src.split('\n');
    for (const c of f.chunks) {
      const code = lines.slice(c.startLine - 1, c.endLine).join('\n');
      const text = `${f.path}${c.symbol ? ` ${c.symbol}` : ''}\n${code}`.slice(0, MAX_CHUNK_CHARS);
      chunks.push({
        path: f.path,
        symbol: c.symbol,
        startLine: c.startLine,
        endLine: c.endLine,
        text,
        contentHash: createHash('sha256').update(text).digest('hex'),
      });
    }
  }
  return { chunks, excluded };
}
