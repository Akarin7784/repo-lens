# 示例 fixture(示例数据,不是真实解析结果)

- `hono.sample.graph.json`、`zustand.sample.graph.json` 是**手写的示例数据**:仿照 honojs/hono、pmndrs/zustand 的真实目录风格,文件、行数和依赖关系都是近似值,**不代表这两个仓库的真实解析结果**。
- `meta.commitSha` 为 40 个 0 的占位值;真实预解析结果会锁定 commitSha(见 ARCHITECTURE.md §5.2)。
- 只包含「入库数据」:module / dir / file 节点和 file→file 原始边(`weight=1`),file 节点带 `externalDeps`。
  `x:` 外部节点与 `aggregated: true` 聚合边属于 API 层派生数据,这里不存,由 `lib/graph` 按同样规则现算(模拟 API 行为)。
- 由 `scripts/gen-sample-fixtures.mjs` 生成;校验见 `lib/fixtures/fixtures.test.ts`(用 `@repolens/shared` 的 `GraphDataSchema`)。
- **环(示例数据)**:hono 示例里人为加了一条 `src/utils/url.ts → src/request.ts` 回边,并在 `meta.cycles` 写入 `[["f:src/request.ts","f:src/utils/url.ts"]]`,只用于验证环边样式;不代表 hono 真实依赖。真实环数据等 T-003。
