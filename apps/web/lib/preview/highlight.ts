/**
 * T-223 代码高亮(Shiki,按需加载)。
 * - 只在用户展开「查看代码」时 `import('shiki/core')`,不进首屏 bundle;只注册常用语言,未知后缀按纯文本。
 * - 安全:只用 `codeToTokens` 拿 token(文本 + 颜色),由 React 以文本节点渲染;
 *   不使用 Shiki 生成的 HTML 字符串,也不使用 dangerouslySetInnerHTML。
 * - 正则引擎用 JavaScript 引擎,不加载 onig.wasm。
 */

/** 前端单次最多渲染的行数(与接口 FILE_MAX_LINES 一致,作为前端兜底) */
export const PREVIEW_MAX_LINES = 2000;
/** 单行超过这么多字符视为超长行:整份文件不做高亮,该行截断显示 */
export const PREVIEW_MAX_LINE_CHARS = 2000;

export type Tok = { content: string; color?: string; dark?: string };
export type Highlighter = (code: string, lang: string) => Promise<Tok[][]>;

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
};

/** 路径 → Shiki 语言 id;未知后缀返回 null(纯文本) */
export function langOf(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return null;
  return LANG_BY_EXT[base.slice(i + 1).toLowerCase()] ?? null;
}

let core: Promise<{
  codeToTokens: (
    code: string,
    o: { lang: string; themes: { light: string; dark: string } },
  ) => { tokens: { content: string; color?: string; htmlStyle?: Record<string, string> }[][] };
}> | null = null;

function loadCore() {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/rust.mjs'),
        import('shiki/langs/java.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/shellscript.mjs'),
      ],
      engine: createJavaScriptRegexEngine(),
    }) as never;
  })();
  // 加载失败时允许下次重试
  core.catch(() => {
    core = null;
  });
  return core;
}

/** 默认高亮器:返回逐行 token(只含文本和颜色) */
export const shikiHighlight: Highlighter = async (code, lang) => {
  const h = await loadCore();
  const { tokens } = h.codeToTokens(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
  });
  return tokens.map((line) =>
    line.map((t) => ({
      content: t.content,
      color: t.htmlStyle?.color ?? t.color,
      dark: t.htmlStyle?.['--shiki-dark'],
    })),
  );
};
