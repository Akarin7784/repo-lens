import { AnalyzerError } from './errors.js';
import type { LanguageAnalyzer, RepoSnapshot } from './types.js';

export type AnalyzerFactory = () => LanguageAnalyzer;

/**
 * 分析器注册表:按注册顺序返回第一个 supports() 为真的分析器。
 * 存工厂而不是实例:分析器有状态(ts-morph Project),每次分析新建一个,避免并发任务互相污染。
 */
export class AnalyzerRegistry {
  private readonly factories: AnalyzerFactory[] = [];

  register(factory: AnalyzerFactory): this {
    this.factories.push(factory);
    return this;
  }

  async detect(repo: RepoSnapshot): Promise<LanguageAnalyzer> {
    for (const make of this.factories) {
      const a = make();
      if (await a.supports(repo)) return a;
      a.dispose();
    }
    throw new AnalyzerError('UNSUPPORTED_LANGUAGE', '第 1 周仅支持 TypeScript 仓库');
  }
}
