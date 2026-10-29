import { describe, expect, it } from 'vitest';
import { CitationSchema } from '@repolens/shared';
import { CitationStream, type CitationOutput } from './citations.js';
import type { Snippet } from './prompt.js';

const snippets: Snippet[] = [
  { n: 1, path: 'src/db/index.ts', startLine: 10, endLine: 48, content: '', moduleId: 'm:src/db' },
  { n: 2, path: 'src/app.ts', startLine: 1, endLine: 20, content: '' },
  { n: 3, path: 'src/db/index.ts', startLine: 40, endLine: 60, content: '' },
];

function run(tokens: string[]) {
  const s = new CitationStream(snippets);
  const out: CitationOutput[] = [];
  for (const t of tokens) out.push(...s.push(t));
  out.push(...s.end());
  const text = out.map((o) => (o.type === 'token' ? o.text : '')).join('');
  const cites = out.flatMap((o) => (o.type === 'citation' ? [o.citation] : []));
  return { out, text, cites, dropped: s.dropped };
}

describe('CitationStream', () => {
  it('去掉标记,在原位置后产出 citation,字段符合 shared schema 且无 Sn', () => {
    const { out, text, cites } = run(['连接在这里[[S1:12-14]]创建。']);
    expect(text).toBe('连接在这里创建。');
    expect(out.map((o) => o.type)).toEqual(['token', 'citation', 'token']);
    expect(cites[0]).toEqual({
      id: 1,
      path: 'src/db/index.ts',
      startLine: 12,
      endLine: 14,
      nodeId: 'f:src/db/index.ts',
      moduleId: 'm:src/db',
    });
    expect(CitationSchema.safeParse(cites[0]).success).toBe(true);
    expect(cites[0]).not.toHaveProperty('n');
  });

  it('标记被切到多个 token 里也能识别', () => {
    const tokens = ['见', '[', '[', 'S', '2', ':', '3', '-', '5', ']', ']', '。'];
    const { out, text, cites } = run(tokens);
    expect(text).toBe('见。');
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ id: 1, path: 'src/app.ts', startLine: 3, endLine: 5 });
    expect(out.findIndex((o) => o.type === 'citation')).toBe(1);
    expect(cites[0]).not.toHaveProperty('moduleId');
  });

  it('切分点任意位置结果一致', () => {
    const full = 'a[[S1:11-12]]b[[S9:1-2]]c[[S2:4-4]]d[[S1:12]]e';
    for (let i = 1; i < full.length; i++) {
      const r = run([full.slice(0, i), full.slice(i)]);
      expect(r.text).toBe('abcde');
      expect(r.cites.map((c) => c.id)).toEqual([1, 2, 3]);
      expect(r.dropped).toBe(1);
    }
  });

  it('未知 Sn、a>b、行号 0、无交集:只去文本,不产出事件,计入 dropped', () => {
    const { text, cites, dropped } = run([
      'x[[S4:1-2]][[S0:1-2]][[S2:5-3]][[S2:0-3]][[S2:21-30]][[S1:1-9]]y',
    ]);
    expect(text).toBe('xy');
    expect(cites).toEqual([]);
    expect(dropped).toBe(6);
  });

  it('越界收缩到与片段的交集', () => {
    const { cites } = run(['[[S1:5-12]][[S1:47-99]]']);
    expect(cites.map((c) => [c.startLine, c.endLine])).toEqual([
      [10, 12],
      [47, 48],
    ]);
  });

  it('id 按首次出现编号;同文件同(收缩后)范围沿用 id,每次都产出事件', () => {
    const { cites } = run([
      '[[S2:1-3]] [[S1:10-12]] [[S2:1-3]] [[S1:5-12]] [[S3:45-46]] [[S1:45-46]]',
    ]);
    // S1:5-12 收缩为 10-12 与第二个相同;S3 与 S1 同文件同范围也相同
    expect(cites.map((c) => c.id)).toEqual([1, 2, 1, 2, 3, 3]);
  });

  it('不像标记的方括号原样保留;流结束时半截标记当文本', () => {
    expect(run(['arr[0] 和 [[x]] 以及 [S1:1]']).text).toBe('arr[0] 和 [[x]] 以及 [S1:1]');
    expect(run(['arr[0] m[[1]] [[0]] [[S1]] [[Sabc]]']).text).toBe(
      'arr[0] m[[1]] [[0]] [[S1]] [[Sabc]]',
    );
    const r = run(['结尾[[S1:1']);
    expect(r.text).toBe('结尾[[S1:1');
    expect(r.cites).toEqual([]);
  });

  it('半截标记在缓冲中不提前输出', () => {
    const s = new CitationStream(snippets);
    expect(s.push('好[[S1:1')).toEqual([{ type: 'token', text: '好' }]);
    expect(s.push('2-13]]')).toEqual([expect.objectContaining({ type: 'citation' })]);
  });

  it('模型自带的路径不被采用', () => {
    const { text, cites } = run(['[[S1:12-13]](/etc/passwd)']);
    expect(cites[0]?.path).toBe('src/db/index.ts');
    expect(text).toBe('(/etc/passwd)');
  });
  it('单行标记 [[Sn:a]] 按 a-a 处理,合法;跨 token 拼接也能识别', () => {
    for (const toks of [['见[[S1:12]]处'], ['见[[S1:1', '2]]处'], ['见[[S1:12]', ']处']]) {
      const { text, cites } = run(toks);
      expect(text).toBe('见处');
      expect(cites.map((c) => [c.startLine, c.endLine])).toEqual([[12, 12]]);
    }
  });

  it('单行标记在片段范围外:剔除并计入 dropped', () => {
    const r = run(['a[[S1:3]]b']);
    expect([r.text, r.cites, r.dropped]).toEqual(['ab', [], 1]);
  });

  it('同文件同行的单行标记与 a-a 标记共用 id', () => {
    const { cites } = run(['[[S1:12]] [[S1:12-12]]']);
    expect(cites.map((c) => c.id)).toEqual([1, 1]);
  });

  it('[[S1:]] 格式不合法:剔除,不发 citation,计入 dropped', () => {
    const r = run(['a[[S1:]]b']);
    expect([r.text, r.cites, r.dropped]).toEqual(['ab', [], 1]);
  });

  it('[[S1:a-b]] / [[S1:3-]] 格式不合法:剔除,不发 citation,计入 dropped', () => {
    const r = run(['a[[S1:a-b]]b[[S1:3-]]c']);
    expect([r.text, r.cites, r.dropped]).toEqual(['abc', [], 2]);
  });

  it('arr[0] 等正常方括号不被删', () => {
    expect(run(['const v = arr[0] + m[1][2];']).text).toBe('const v = arr[0] + m[1][2];');
  });

  it('半截标记缓冲超过 24 字符当文本输出;流结束残留仍当文本', () => {
    const s = new CitationStream(snippets);
    const long = '[[S1:' + '1'.repeat(30);
    const out = s.push(long);
    expect(out).toEqual([{ type: 'token', text: long }]);
    const r = run(['尾巴[[S1:12-']);
    expect([r.text, r.cites]).toEqual(['尾巴[[S1:12-', []]);
  });
});
