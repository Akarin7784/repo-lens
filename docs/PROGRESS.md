# 开发进度记录

由项目管理角色维护。每合并一个 PR、每完成一个里程碑都在这里记一条。时间为北京时间。

## 里程碑
| 周 | 目标 | 状态 |
|---|---|---|
| W1 | TS 解析与基础图:脚手架、clone 与文件树、`TypeScriptAnalyzer`、依赖图 JSON、前端出图、任务与 SSE 进度 | 进行中 |
| W2 | 分层摘要、节点详情、Qdrant 索引 | 未开始 |
| W3 | 代码 RAG 问答、引用校验、图上高亮联动 | 未开始 |
| W4 | MCP 服务、预解析示例仓库、演示脚本与兜底视频、README | 未开始 |

## 第 1 周任务
| 编号 | 任务 | 负责 | 状态 | PR |
|---|---|---|---|---|
| T-001 | Monorepo 脚手架、CI、docker-compose、`packages/shared` 的 zod 类型 | 架构师 | 已合并 | [#5](https://github.com/Akarin7784/repo-lens/pull/5) |
| T-002 | `LanguageAnalyzer` 接口、registry、`TypeScriptAnalyzer` | 后端与AI设计师 | 已合并 | [#7](https://github.com/Akarin7784/repo-lens/pull/7) |
| T-003 | API 与 Worker:`POST /api/repos`、任务 SSE、clone 与文件树 | 后端与AI设计师 | 已合并 | [#10](https://github.com/Akarin7784/repo-lens/pull/10) |
| T-004 | Web:设计令牌、首页、基于 fixture 的图渲染(React Flow + elkjs) | 前端可视化设计师 | 已合并 | [#8](https://github.com/Akarin7784/repo-lens/pull/8) |
| T-005 | CI 冒烟任务:真实构建镜像、起 compose、请求 `/health` | 架构师 | 已合并 | [#9](https://github.com/Akarin7784/repo-lens/pull/9) |

## 第 1 周未验证项
- ✅ 已验证(T-005,PR #9,[CI run](https://github.com/Akarin7784/repo-lens/actions/runs/40759576746)):镜像构建和 `docker compose up`,api `/health` 返回 `status:ok`,web 返回 200。
- ✅ 已处理(T-005):本机 Node 24 与 CI、Dockerfile 的 Node 20 不一致,CI、三个 Dockerfile、`.nvmrc` 和 `engines` 均固定 20,README 已说明差异,并要求提交前用 Node 20 跑一遍测试。
- ✅ 已验证(T-005,PR #9,[CI run](https://github.com/Akarin7784/repo-lens/actions/runs/40759576746)):Docker 镜像内 `tree-sitter`(0.22.4,原生绑定)能安装并运行,worker 镜像内用 TypeScriptAnalyzer 解析示例 TS(2 文件、3 节点、1 条边、0 语法错误)。
- 语法错误文件数(tree-sitter-typescript 不支持部分语法):zustand 5 个、hono 8 个(共 450 个文件)、zod 4 个(共 522 个文件)。import 仍能提取,只影响这些文件的符号和切块。

- ✅ 已验证(T-003,PR #10,[CI run](https://github.com/Akarin7784/repo-lens/actions/runs/40764333935)):真实 `mysql:8.4` 上 api 迁移通过,api 监听 4000,worker 进入队列监听;启动顺序靠 healthcheck、`service_healthy`、有限次重试和 `waitForSchema` 保证。
- 已验证(PR #14,CI smoke):api → MySQL 8.4 → Redis(BullMQ)→ worker 的真实业务链路。提交 zustand 固定 commit `382d29c`,SSE 收到 `graph_ready` 与 `done`(约 2s,stats 23 节点/23 边),再逐层请求图接口并校验 id 前缀、边类型、`srcFileId`、端点在 nodes 内。仍未覆盖:Qdrant、真实 LLM(summarizing/embedding 目前是空阶段)、问答(`/chat`)、web 接真实接口。聚合边断言已在 CI smoke 覆盖(ci/smoke-aggregated-edges,展开 zustand `m:src/middleware`);非法参数返回 400 的断言待 #17 合并后补。

## 后续项(来自 T-003 评审)
- [#12](https://github.com/Akarin7784/repo-lens/issues/12):请求 `parentId` 时返回跨子树聚合边(`aggregated:true`、`weight`,外端为 LCA(P,Y) 的直接子节点,外端节点要放进 nodes)。验证例子用 zustand 的 `m:src/middleware`(hono 根层没有跨模块边,需换一个展开例子)。负责:后端与AI设计师。
- 非法图查询改返回 400(`BAD_REQUEST` 已在 [#13](https://github.com/Akarin7784/repo-lens/pull/13) 加入 shared),后端另开 PR。
- ~~smoke 业务步骤~~:PR [#14](https://github.com/Akarin7784/repo-lens/pull/14) 已合并(提交 1ada2f0)。聚合边断言已补(PR [#20](https://github.com/Akarin7784/repo-lens/pull/20),注意其「恰好一端在 P 内」只适用于子节点是文件的展开,扩到目录展开时放宽为至少一端在 P 内);400 断言待 #17 合并后补;仍未覆盖 Qdrant、LLM、`/chat`。
- 经 web 代理访问 api 已加入 smoke(分支 ci/smoke-via-web,`scripts/ci-smoke-web-proxy.mjs`):经 `http://localhost:3000/api/repos/999999` 必须得到 api 的 404 `REPO_NOT_FOUND` JSON。当前 main 上预期红(web 镜像构建时未传 `API_PROXY_TARGET`),待 #18 修复 Dockerfile/compose 并合并后验证为绿。
- 仓库体积限制:`MAX_REPO_MB` 统一为 300(#11 与本次);worker 扫描后另设 `MAX_SOURCE_MB`(默认 50),并给克隆目录加体积上限(目前只有超时保护)。
- 限流:重复提交已分析完成的同一仓库、同一 commit(复用结果、没有新任务入队)不计入每小时 5 次限额,只有真正入队的新任务才计数,PR 要带测试。负责:后端与AI设计师(与 `meta.cycles` 同一个小 PR)。
- `meta.cycles` 按强连通分量的成员集合处理,不是有序路径;同时修 `projection.ts` 并在文档写明,用 hono 的 5 个环验证;前端把分量内部的边都标成环边。负责:后端与AI设计师、前端可视化设计师。
- 首屏自动下探:hono 的 module 层只有 9 个节点、0 条边,首屏会是一排互不相连的方块。`GraphData.meta` 增加可选字段 `suggestedFocus?: NodeId`,根层请求时若当前层子节点之间的边少于 3 条,就下探到其中 loc 最大的节点,最多重复 3 层,边数达到 3 条或没有可下探节点时停止;边够用时不返回该字段。预期 hono 落在 `d:src` 或其下一级。前端首次加载时自动展开它,根层 module 作为面包屑保留,用户手动折叠后不再自动展开。要求在第 2 周开始前合并,是第 1 周收尾项。负责:后端与AI设计师(shared、实现、测试、文档),前端可视化设计师(接入)。
- 前端接真实图接口,替换示例数据并去掉「示例数据」标签;用 hono 的 5 个环验证环边样式。负责:前端可视化设计师。

## 日志
- 2026-10-29 03:3x:仓库建立,三份设计文档和 Claude 风格规范提交到 `docs/`,拆分第 1 周任务。
- 2026-10-29 03:5x:T-001 合并(PR #5,squash,提交 c31061f)。评审时我在干净环境里独立跑了 install(frozen-lockfile)、lint、typecheck、build、test,全部通过;逐项核对 `packages/shared` 与设计结论一致(无 `verified`/`reset`,`droppedCitations`,`error` 四个错误码)。确认四点:聚合边为 `type:'imports'` + `aggregated:true`(与此前口头约定的 `type:'aggregated'` 不同,以 shared 为准,已通知前端);`x:` 节点 `path` 为包名;详情 `kind` 允许 `dir`/`external`;compose 数据服务只绑 `127.0.0.1`。遗留:Dockerfile 与 `docker compose up` 尚未在有 Docker 的环境验证;T-002 起注意本机 Node 24 与 CI/镜像 Node 20 的原生绑定一致性。同时修复 CONTRIBUTING.md 被格式化后一条说明并入编号的问题。
- 2026-10-29 04:0x:T-002 合并(PR #7,squash,提交 f07ce85)。评审时独立跑了 install、lint、typecheck、build、test,全部通过,并自己 clone 三个演示仓库跑 analyzer 基准,结果与 PR 描述一致。实测规模(全量图,未排除测试和文档):

  | 仓库 | commit | 源码文件 | 节点 module/dir/file | 边 | 环 | 耗时 |
  |---|---|---|---|---|---|---|
  | zustand | 382d29c | 49 | 65(4/12/49) | 73 | 0 | 约 0.19 秒 |
  | hono | ed1d5f7 | 450 | 571(9/112/450) | 1147 | 5 | 约 1.3 秒 |
  | zod | b1f6ba0 | 522 | 582(9/51/522) | 849 | 1 | 约 1.3 秒 |

  结论:hono 和 zod 超过 300 节点,默认只出 module 层并按 `parentId` 懒加载是必须的。对 T-003 的要求:scanning 默认排除测试、文档、示例和隐藏目录(zod 扫进了 `.claude/skills`),规则公开并重测节点数;资源类 import 只计数不进图;单文件超时和并发写进任务或后续项。三处与后端文档的差异(`srcFileId` 用 `f:<path>`、构造函数接收文件集、全量图由 T-003 投影)按 shared 为准,待架构师确认后同步 `BACKEND_AI_DESIGN.md`。tree-sitter 固定为 0.22.4(0.25.1 在 Node 20 段错误)。
- 2026-10-29 04:1x:T-005 合并(PR #9,squash,提交 f05d368)。评审时核对了 CI 日志:`ci` 与 `smoke` 两个 job 在 rebase 后的最新提交上都通过,三个镜像无缓存构建 77 秒,`/health` 返回 `status:ok`,web 返回 200,镜像内 Node 20.20.2,tree-sitter 0.22.4 在 node:20-alpine 上能加载并解析 TS。第一次评审时发现 PR 与 `main` 有冲突导致最新提交没有触发 CI,已让作者 rebase 后重跑再合并。未覆盖:api 连 MySQL/Redis/Qdrant 的业务链路和 worker 取任务,待 T-003 后在 smoke 里补一次真实提交分析任务。第 1 周的 Docker 与镜像内 tree-sitter 未验证项全部关闭。
- 2026-10-29 04:2x:T-004 合并(PR #8,squash,提交 503db47)。第一轮评审发现 CI 失败:`jsdom@30` 依赖的 `undici@8` 在 Node 20 下报错,作者本机 Node 24 没有复现;要求降级并在 Node 20 下本地验证,jsdom 现为 `^26.1.0`。同时定了设计决定:新增 `--accent-strong`(浅色 `#B5502F`,深色 `#E08A6A`)用于按钮和选中描边,按钮文字对比度 5.06/6.35,选中描边对画布 4.35;图区令牌写进 `DESIGN_STYLE.md`;交互为单击选中并高亮邻居、双击或点 ▸ 展开(采纳绿色三角形的投屏防误触建议);环边用赭色虚线加 ↻ 标记,type-only 边改为更淡的点线,图例两项都有;中文标题加 Noto Serif SC 回退。图页目前读的是手写示例数据,页面带「示例数据」标签。后续项:选中后变暗的边箭头没有变暗;环边待 T-003 真实数据(hono 有 5 个环)验证;首页副标题空格偏散;真实投影仪、Safari、Firefox 未验证;T-003 合并后把示例数据换成真实预解析结果。
- 2026-10-29 04:5x:T-003 合并(PR #10,squash,提交 66ef384)。第一轮评审发现 `smoke` 失败:MySQL 容器未就绪时 api 和 worker 在 `runMigrations` 报 `ECONNREFUSED` 后直接退出,本机 MariaDB 复现不了。要求加 healthcheck 与 `service_healthy`、连接有限次重试、只让 api 迁移并用 `GET_LOCK` 互斥、加 `restart: unless-stopped`。修复后我在最新提交 3a7b4de 上独立重跑 install、lint、typecheck、build、test 全通过(shared 20、analyzer 32、db 9、api 18、worker 16、web 27),CI 日志确认 api 和 worker 在真实 MySQL 8.4 上正常启动。范围决定:聚合边(#12)和非法查询返回 400 不进本 PR,分别单独做;`BAD_REQUEST` 经 #13 加入 shared。仓库大小上限统一为 300MB(#11)。安全上,克隆只走 https、服务端拼地址、干净环境并关闭 hooks。扫描排除规则实测:zustand 23 个节点、hono 338 个、zod 196 个,默认仍以 module 层加 `parentId` 懒加载。
- 2026-10-29 04:5x:smoke 业务步骤合并(PR #14,squash,提交 1ada2f0)。评审时核对 CI 日志:提交 zustand 固定 commit 后 202 受理,SSE 依次经过 cloning、scanning、parsing,约 0.9s 到 `done`,stats 为 18 个文件、4 个模块、23 个节点、23 条边;逐层请求图接口,root 4 个节点 5 条边,展开 `m:src/middleware` 得到 7 个节点和 1 条带 `srcFileId` 的文件边。脚本只用 Node 20 自带 fetch,失败时打印 api、worker、mysql 日志尾部。局限:依赖从 GitHub 克隆 zustand,网络抖动可能偶发失败;Qdrant、LLM、`/chat`、聚合边未覆盖,#12 合并后补断言。
- 2026-10-29 12:3x:#17 合并(提交 7dc62ec)、#19 合并(提交 e3e6509)。我在干净 worktree 里对三个 PR(#17、#19、#21)独立跑了 install、lint、typecheck、build、test,全部通过,三个依次合入 main 的临时分支也无冲突,CI 的 `ci` 与 `smoke` 在各自最新提交上都是绿的。#17:graph 查询 `.strict()`,只接受 `parentId` 与 `includeExternal`,id 或 nodeId 格式非法返回 400 `BAD_REQUEST`,格式合法但不存在仍是 404;#16 的 `graph:v2` 缓存和 `x-graph-truncated`(仅表示 P 的直接子节点被 300 上限截断)保留。#19:`meta.cycles` 按强连通分量成员集合投影(自环与单成员环去掉),限流只统计真正入队的新任务和失败重试,缓存版本升到 3。已知局限:同一个新仓库并发提交会多计一次(偏严,不会漏计);带 `_t=` 这类额外参数的图请求现在返回 400。#21(`suggestedFocus`)在 #19 被 squash 后与 main 冲突,待作者把 main 合进分支再合并。架构师裁定的后续小 PR:边的可选字段 `inCycle`(聚合边只要底层有一条文件边在环里就为 true,前端环边只读它)、`RepoStatusSchema` 加 `repo` 与 `commitSha`、被拒绝提交的宽松计数器(同一来源每小时 60 次)、校验错误不再统一映射为 `INVALID_REPO_URL`。#18 仍等前端推送 Dockerfile、compose 与 `turbo.json` 的环境变量修复。
