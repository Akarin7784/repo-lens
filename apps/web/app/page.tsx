import { SUPPORTED_LANGUAGES } from '@repolens/shared';

// 占位首页:设计令牌与真实首页在 T-004 实现(见 docs/DESIGN_STYLE.md)
export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: '96px auto', padding: '0 24px' }}>
      <h1>RepoLens</h1>
      <p>输入 GitHub 仓库地址,生成可交互的架构图并用自然语言提问。</p>
      <p>当前支持的语言:{SUPPORTED_LANGUAGES.join(', ')}</p>
    </main>
  );
}
