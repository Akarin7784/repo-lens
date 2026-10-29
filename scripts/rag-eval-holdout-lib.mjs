// rag-eval 留出集(v2、v3…)的纯函数:配置、解析、判分。不触发任何检索、改写或 embedding,便于单独测试。
// 题号字母、仓库提交、判分前缀、题数都来自配置(可被命令行参数覆盖),不再写死;代码里不写题目文字或答案。

/** 已知留出集。新增版本只加配置,判分逻辑不变。 */
export const HOLDOUTS = {
  v2: {
    name: 'v2',
    repo: 'zod',
    file: 'docs/RAG_HOLDOUT_V2.md',
    idLetter: 'V',
    commit: 'b1f6ba06c5de0e600640917615e5df70fa73f060',
    prefix: 'packages/zod/src/v4/',
    expectedRows: 10,
    dirEnv: 'ZOD_DIR',
  },
  v3: {
    name: 'v3',
    repo: 'h3',
    file: 'docs/RAG_HOLDOUT_V3.md',
    idLetter: 'W',
    commit: 'f0e17808ac2439b6434bb10609a961067f4d555b',
    prefix: 'src/',
    expectedRows: 10,
    dirEnv: 'H3_DIR',
  },
};

const argValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} 缺少取值`);
  return v;
};

/**
 * 取留出集配置:先取 HOLDOUTS[name],再用显式参数覆盖
 * --id-letter X  --commit <40位sha>  --prefix <路径前缀/>  --rows N  --holdout-file <路径>
 */
export function resolveHoldoutConfig(name, argv = []) {
  const base = HOLDOUTS[name];
  if (!base) throw new Error(`未知留出集「${name}」,可选:${Object.keys(HOLDOUTS).join(',')}`);
  const cfg = { ...base };
  const letter = argValue(argv, '--id-letter');
  const commit = argValue(argv, '--commit');
  const prefix = argValue(argv, '--prefix');
  const rows = argValue(argv, '--rows');
  const file = argValue(argv, '--holdout-file');
  if (letter !== undefined) cfg.idLetter = letter;
  if (commit !== undefined) cfg.commit = commit;
  if (prefix !== undefined) cfg.prefix = prefix;
  if (rows !== undefined) cfg.expectedRows = Number(rows);
  if (file !== undefined) cfg.file = file;
  return validateHoldoutConfig(cfg);
}

export function validateHoldoutConfig(cfg) {
  if (!/^[A-Z]$/.test(cfg.idLetter)) throw new Error(`题号字母须为单个大写字母「${cfg.idLetter}」`);
  if (!/^[0-9a-f]{40}$/.test(cfg.commit)) throw new Error(`提交须为 40 位 sha「${cfg.commit}」`);
  if (!cfg.prefix || !cfg.prefix.endsWith('/') || cfg.prefix.startsWith('/'))
    throw new Error(`判分前缀须为以 / 结尾的相对目录「${cfg.prefix}」`);
  if (!Number.isInteger(cfg.expectedRows) || cfg.expectedRows < 1)
    throw new Error(`题数须为正整数「${cfg.expectedRows}」`);
  return cfg;
}

/**
 * 解析表格:列为 编号 | 类型 | 问题 | 参考文件(`;` 或 `;` 分隔,反引号包裹的完整路径)| 参考符号 | 理由。
 * 严格:以 `| <字母>` 开头的行都必须解析成功;行数必须正好 expectedRows;编号 <字母>1..n 依次;
 * 每个路径必须以 prefix 开头且不以 / 结尾(只允许完整文件路径)。
 */
export function parseHoldout(md, { idLetter, prefix, expectedRows, file = '留出集' }) {
  const rows = [];
  const lines = md.split(/\r?\n/);
  const rowRe = new RegExp(`^\\|\\s*${idLetter}`);
  const idRe = new RegExp(`^${idLetter}\\d+$`);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!rowRe.test(line)) continue;
    const where = `${file} 第 ${i + 1} 行`;
    if (!line.endsWith('|')) throw new Error(`${where}:表格行未以 | 结尾`);
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length !== 6) throw new Error(`${where}:应为 6 列,实际 ${cells.length} 列`);
    const [id, , question, refs] = cells;
    if (!idRe.test(id)) throw new Error(`${where}:编号无法解析「${id}」`);
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
      if (!path.startsWith(prefix) || path.endsWith('/') || /\s/.test(path))
        throw new Error(`${where}:参考文件须为 ${prefix} 下的完整文件路径「${path}」`);
      return path;
    });
    rows.push({ id, question, want });
  }
  if (rows.length !== expectedRows)
    throw new Error(`${file} 题目行数应为 ${expectedRows},实际 ${rows.length}`);
  const ids = rows.map((r) => r.id);
  const expectIds = Array.from({ length: expectedRows }, (_, k) => `${idLetter}${k + 1}`);
  if (ids.join(',') !== expectIds.join(','))
    throw new Error(`${file} 编号应依次为 ${expectIds.join(',')},实际 ${ids.join(',')}`);
  return rows;
}

/** 文件级完整路径精确匹配:必须在判分前缀下且与任一参考路径完全相等;忽略符号。 */
export function okFile(path, want, prefix) {
  return typeof path === 'string' && path.startsWith(prefix) && want.includes(path);
}

/** 判分:hit5 = 前 5 个切块有任一命中;top1 = 第 1 位命中;firstRank = 首个命中名次(无则 null)。 */
export function judge(paths, want, prefix) {
  const top = paths.slice(0, 5);
  const idx = top.findIndex((p) => okFile(p, want, prefix));
  return { hit5: idx >= 0, top1: idx === 0, firstRank: idx >= 0 ? idx + 1 : null };
}

/**
 * 单题计分(与 v2 一致):改写失败或检索降级(retrieval !== 'hybrid')都记 FAILED,计未命中。
 * rewriteUsed=false 时不检索,paths 忽略。
 */
export function scoreQuestion({ rewriteUsed, retrieval, paths = [], want, prefix }) {
  if (!rewriteUsed) return { failed: true, hit5: false, top1: false, firstRank: null };
  const j = judge(paths, want, prefix);
  const degraded = retrieval !== 'hybrid';
  return {
    failed: degraded,
    hit5: j.hit5 && !degraded,
    top1: j.top1 && !degraded,
    firstRank: j.firstRank,
  };
}

/** 一次性运行保护:结果文件已存在且未加 --force 时拒绝。exists 由调用方传入以便测试。 */
export function assertRunOnce({ name, resultFile, exists, force }) {
  if (exists && !force)
    throw new Error(
      `${name} 结果文件 ${resultFile} 已存在,${name} 只许跑一次;确需重跑请显式加 --force`,
    );
}
