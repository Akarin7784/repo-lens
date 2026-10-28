import { DemoRepoList } from '../components/home/DemoRepoList';
import { RepoUrlInput } from '../components/home/RepoUrlInput';
import { ThemeToggle } from '../components/theme/ThemeToggle';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="font-serif text-[18px] font-semibold text-fg">RepoLens</span>
        <ThemeToggle />
      </header>
      <section className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center gap-6 px-6 pb-24">
        <h1 className="text-center font-serif text-[40px] font-semibold leading-tight text-fg">
          读懂一个仓库,从一张图开始
        </h1>
        <p className="text-center text-[15px] leading-relaxed text-muted">
          贴上 GitHub 地址,按 模块 → 目录 → 文件 逐层展开它的依赖结构。
        </p>
        <RepoUrlInput />
        <DemoRepoList />
      </section>
    </main>
  );
}
