// rag-eval v2 的纯函数(解析 + 判分),不触发任何检索、改写或 embedding,便于单独测试。
// 题目只从 docs/RAG_HOLDOUT_V2.md 的 `| V… |` 表格行机械解析;代码里不写题目文字或答案。

export const ZOD_SHA = 'b1f6ba06c5de0e600640917615e5df70fa73f060';
export const V4_PREFIX = 'packages/zod/src/v4/';
export const V2_EXPECTED_ROWS = 10;

/**
 * 解析表格:列为 编号 | 类型 | 问题 | 参考文件(`;` 或 `;` 分隔,反引号包裹的完整路径)| 参考符号 | 理由。
 * 严格:以 `| V` 开头的行都必须解析成功;行数必须正好 expectedRows;编号 V1..Vn 唯一;
 * 每个路径必须以 packages/zod/src/v4/ 开头且不以 / 结尾(只允许完整文件路径)。
 */
export function parseHoldoutV2(md, expectedRows = V2_EXPECTED_ROWS) {
  const rows = [];
  const lines = md.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!/^\|\s*V/.test(line)) continue;
    const where = `RAG_HOLDOUT_V2.md 第 ${i + 1} 行`;
    if (!line.endsWith('|')) throw new Error(`${where}:表格行未以 | 结尾`);
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length !== 6) throw new Error(`${where}:应为 6 列,实际 ${cells.length} 列`);
    const [id, , question, refs] = cells;
    if (!/^V\d+$/.test(id)) throw new Error(`${where}:编号无法解析「${id}」`);
    if (!question) throw new Error(`${where}:问题为空`);
    const parts = refs
      .split(/[;;]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) throw new Error(`${where}:参考文件为空`);
    const want = parts.map((p) => {
      const m = /^`([^`]+)`$/.exec(p);
      if (!m) throw new Error(`${where}:参考文件须为反引号包裹的完整路径「${p}」`);
      const path = m[1].trim();
      if (!path.startsWith(V4_PREFIX) || path.endsWith('/') || /\s/.test(path))
        throw new Error(`${where}:参考文件须为 ${V4_PREFIX} 下的完整文件路径「${path}」`);
      return path;
    });
    rows.push({ id, question, want });
  }
  if (rows.length !== expectedRows)
    throw new Error(`RAG_HOLDOUT_V2.md 题目行数应为 ${expectedRows},实际 ${rows.length}`);
  const ids = rows.map((r) => r.id);
  const expectIds = Array.from({ length: expectedRows }, (_, k) => `V${k + 1}`);
  if (ids.join(',') !== expectIds.join(','))
    throw new Error(`RAG_HOLDOUT_V2.md 编号应依次为 ${expectIds.join(',')},实际 ${ids.join(',')}`);
  return rows;
}

/** 文件级完整路径精确匹配:必须在 v4 前缀下且与任一参考路径完全相等;忽略符号。 */
export function okFileV2(path, want) {
  return typeof path === 'string' && path.startsWith(V4_PREFIX) && want.includes(path);
}

/** 判分:hit5 = 前 5 有任一命中;top1 = 第 1 位命中;firstRank = 首个命中名次(无则 null)。 */
export function judgeV2(paths, want) {
  const top = paths.slice(0, 5);
  const idx = top.findIndex((p) => okFileV2(p, want));
  return { hit5: idx >= 0, top1: idx === 0, firstRank: idx >= 0 ? idx + 1 : null };
}
