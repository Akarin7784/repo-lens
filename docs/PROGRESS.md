# 开发进度记录

由项目管理角色维护。每合并一个 PR、每完成一个里程碑都在这里记一条。时间为北京时间。

## 里程碑
| 周 | 目标 | 状态 |
|---|---|---|
| W1 | TS 解析与基础图:脚手架、clone 与文件树、`TypeScriptAnalyzer`、依赖图 JSON、前端出图、任务与 SSE 进度 | 已完成(2026-10-29,收尾小项见「后续项」) |
| W2 | 分层摘要、节点详情、Qdrant 索引(任务拆分见 [`WEEK2_PLAN.md`](WEEK2_PLAN.md)) | 进行中 |
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
| T-006 | 图接口收尾:聚合边、400 与错误码、`meta.cycles`、`suggestedFocus`、`inCycle`、限流、仓库详情字段 | 后端与AI设计师 | 已合并 | #16、#17、#19、#21、#24、#25、#26、#28 |
| T-007 | Web 接入真实 API:提交分析、SSE 进度、按层加载、`suggestedFocus` 自动展开 | 前端可视化设计师 | 已合并 | #18、#30 |
| T-008 | smoke 覆盖真实分析链路、聚合边、经 web 代理 | 架构师 | 已合并 | #14、#20、#22 |

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
- 经 web 代理访问 api 已加入 smoke(分支 ci/smoke-via-web,`scripts/ci-smoke-web-proxy.mjs`):经 `http://localhost:3000/api/repos/999999` 必须得到 api 的 404 `REPO_NOT_FOUND` JSON。#18 合并前 main 上此步失败(拿到 Next 的 HTML 404,CI run 40776851570);#18(d06aef3)修复 Dockerfile/compose 后,组合验证 run 40817963679 此步通过(404 + application/json `REPO_NOT_FOUND`),合并最新 main 后在 #22 上复验。
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
- 2026-10-29 12:5x:#21 合并(提交 8bc8600)、#18 合并(T-007,提交 d06aef3)。#21:`GraphData.meta.suggestedFocus` 只在根层响应出现,下探规则按边条数统计(少于 3 条就进入 loc 总和最大的子节点,最多 3 层,第 3 层后即使边数不足也停止),缓存版本升到 4;hono 根层得到 `d:src`,zustand 和 zod 不返回该字段。#18:前端接入真实图接口(提交分析、SSE 进度、按层懒加载、聚合边 ×N、截断提示,截图在 `docs/assets/T-007/`)。评审第一轮发现部署缺口:Next 的 `rewrites` 在构建时由 `API_PROXY_TARGET` 固定,但 web 的 Dockerfile 没传,compose 下经 web 的 `/api/*` 会落到 Next 自己的 404 页面,原 smoke 只直连 api,看不出。修复为 Dockerfile 的 `ARG`/`ENV`、compose 的 build args、`turbo.json` 的 build 任务声明 env(turbo 2 严格 env 模式会过滤未声明的变量),并删掉没人读的 `API_BASE_URL`。架构师在「#18 分支加 #22 的 smoke 步骤」的组合 CI 里验证:经 web 访问 `/api/repos/999999` 返回 api 的 404 JSON(对比 main 上是 Next 的 HTML 404),`ci` 与 `smoke` 都绿。我在 #18 最新提交 40b251e 上独立重跑 install、lint、typecheck、build、test 全过(web 54、api 28、shared 20、analyzer 32、db 9、worker 16),与最新 main 试合并无冲突。待办:#22 合并最新 main 后重跑 CI 再合并;前端把环边改为只读 `edge.inCycle`,并接入 `suggestedFocus`;后端的 `inCycle`、`RepoStatusSchema` 补 `repo`/`commitSha`、宽松计数器、校验错误映射几个小 PR;hono 的 60 节点 156 条边视图过密,前端要在第 2 周前给出取舍方案(默认弱化聚合边、选中节点高亮其边、放大后再显示 ×N);浅色与深色渲染的子节点数不一致(25 与 27)尚未解释。未验证:真实 400 文案、`truncated=true`、Safari 与 Firefox、投影仪、大图性能、Docker 本机运行(只来自 CI)。
- 2026-10-29 13:0x:#22 合并(提交 e1c9d1a)、#27 合并(提交 4b5816c)、#28 合并(提交 8949428)。三个 PR 和 #24、#25、#26 一起在各自最新提交上独立重跑 install、lint、typecheck、build、test 全过(并行跑测试会共用同一个 MariaDB 和 Redis 造成假失败,改串行后通过),试合并无冲突,`ci` 与 `smoke` 都绿。#22:smoke 新增经 web(3000 端口)请求 `/api/repos/999999`,要求 404、`application/json` 和 `REPO_NOT_FOUND`;此前 main 上这一步拿到 Next 的 HTML 404,#18 的修复合并后变绿,Dockerfile、compose 与 `turbo.json` 的修复由此有了 CI 证据。#27:`ARCHITECTURE.md` 的 `API_BASE_URL` 改为构建期 `API_PROXY_TARGET`,与 `FRONTEND_DESIGN.md` §7.5 对齐。#28:边增加可选字段 `inCycle`(只在为 true 时返回;文件边两端在同一强连通分量里为 true,聚合边只要底层有一条文件边在环里就为 true),`meta.cycles` 保留,缓存版本升到 5;前端环边之后只读 `edge.inCycle`。#24、#25、#26 按架构师裁定还要小改后再合:#24 的 `commitSha` 优先取最近一次已完成任务的 commit;#25 缺 `repoUrl` 返回 `BAD_REQUEST`,413、415 保留原状态码,错误体 code 统一为 `BAD_REQUEST`;#26 的 5 次(新仓库)和 60 次(提交总量)上限都做成环境变量,复用既有结果不计 5 次但计 60 次,`BACKEND_AI_DESIGN.md` 第 448 行的「3 个新仓库」改成 5。#30(前端接入 `suggestedFocus`)待评审。
- 2026-10-29 13:1x:#30 合并(前端接入 `suggestedFocus`,Closes #29)。我在最新提交 d8df72b 上独立重跑 install、lint、typecheck、build、test 全过(web 61、api 34、shared 21、analyzer 32、db 9、worker 16),与 main 试合并无冲突,`ci` 与 `smoke` 都绿。逻辑核对:首次加载按 parentId 逐层展开到 focus 节点,根层 module 留作外层面包屑;▸、双击、「全部收起」都会先清空自动展开状态,之后不再自动展开;字段不存在时不做兜底;请求失败或路径找不到就停;`autoBusy` 保证同一时间只有一个请求,不会死循环。实测 hono 首屏发 3 个请求落在 `d:src`。后续项(非阻塞):自动请求还没返回时用户点「全部收起」,请求回来后会再展开一层(应在回调里检查自动展开状态);`suggestedFocus` 指向文件时没有类型判断;缺「请求失败就停止」的测试用例;状态栏 84 条边与 API 报的 `d:src` 层 80 条不一致,前端待确认。
- 2026-10-29 13:3x:#24(提交 9e9b3ba)、#25(提交 2409353)、#26(提交 3c7d529)合并,main 上三次提交的 `ci` 与 `smoke` 都是 success。复验在各自最新提交上串行跑 install、lint、typecheck、build、test 全过(api 53、shared 24、web 61、analyzer 32、worker 16、db 9),三个依次叠到 main 也无冲突。#24:`GET /api/repos/:id` 返回 `repo` 和 `commitSha`,`commitSha` 优先取最近一次已完成任务的 commit,没有已完成任务才取最新任务的。#25:只有仓库地址不合法才用 `INVALID_REPO_URL`,缺 `repoUrl` 和其他校验错误用 `BAD_REQUEST`,框架 4xx 保留 400、413、415 原状态码、错误体 code 统一 `BAD_REQUEST`。#26:`RATE_LIMIT_NEW_REPOS_PER_HOUR`(默认 5)与 `RATE_LIMIT_SUBMITS_PER_HOUR`(默认 60)都由环境变量配置,被拒绝或出错的提交不计 5 次,复用已有结果不计 5 次但计 60 次,超过 60 次返回 429 且不建任务,非法值使 api 启动失败。已知小问题(非阻塞):`limits.ts` 与 `.env.example` 注释里把路由写成 `POST /api/analyze`(实际是 `POST /api/repos`);退回计数时按当前时间重算 key,请求跨整点时会少算一次;超过 5 次后计数值继续上涨(有意)。**第 1 周完成**:从粘贴 GitHub 地址到交互式依赖图的链路在 CI 的真实 MySQL 8.4 + Redis + worker 上走通,前端读真实接口,聚合边、环边、首屏自动下探都已落地。未完成与未验证见「后续项」和「演示检查清单」。下一步:第 2 周(分层摘要、节点详情、Qdrant 索引、环边改读 `inCycle`、状态栏口径),任务拆分交给架构师。
- 2026-10-29 13:4x:#31 合并(提交 730a731)。状态栏改为「当前显示 N 节点 / M 条边」,数字严格等于画布上画出的节点和边;hono `d:src` 的 84 条边 = 80 条内部边 + 4 条来自 `d:perf-measures` 和 `d:runtime-tests` 的边界聚合边,展开后 `m:.` 层的 2 条聚合边不再渲染,此口径已写入 `FRONTEND_DESIGN.md`。我在最新提交 42d5681 上独立重跑 lint、typecheck、build、test 全过(web 61),`ci` 与 `smoke` 绿。仍待前端:环边改读 `edge.inCycle`,`suggestedFocus` 回调竞态、文件类型判断和失败停止测试三个小问题。
- 2026-10-29 13:5x:#32 合并(提交 63955d5)。前端环边只读 `edge.inCycle === true`(原始边和聚合边同一规则),状态栏「环边 K」数画出的 inCycle 边;`suggestedFocus` 自动展开补了三处:自动请求返回后若用户已手动操作则丢弃结果(成功与失败都一样,不更新状态也不报错)、只处理 `m:` 与 `d:` 节点、失败即停止。我在最新提交 3a1b593 上独立串行重跑 install、lint、typecheck、build、test(不用缓存)全过,与 main 试合并无冲突,`ci` 与 `smoke` 绿。清理项(非阻塞):`toFlow.ts:21` 注释仍写「meta.cycles 的某个环上」,`state.ts` 里 `cycles` 的收集与 `mergeCycles` 现在是死代码,「迟到结果被丢弃」只测了成功分支。第 1 周遗留的前端项到此全部关闭,下一步等 `docs/WEEK2_PLAN.md`。
- 2026-10-29 14:0x:#33 合并(提交 d3c2df5),第 2 周开始。`docs/WEEK2_PLAN.md` 由架构师拆分:范围以 `ARCHITECTURE.md` §7 为准,加上「切块写入 Qdrant」只建索引,检索、`/chat`、引用校验留第 3 周;后端主线 T-210(LLM 客户端、记账、预算熔断、`FakeLlm`)→ T-211(分层摘要)→ T-212(`/nodes` 真实摘要)→ T-213(`/files` 代码预览)→ T-214(Qdrant 写入),前端主线 T-220(聚合边调淡与 ×N 阈值)→ T-221(悬停预览)→ T-222(节点详情)→ T-223(代码预览)→ T-224(路径搜索),T-225 的 weight≥k 开关可选;第一天先清第 1 周遗留 T-201 到 T-205。关键路径 T-210 → T-211 → T-212 → T-222。需要 Eva 拍板:D1 LLM 供应商与 key(涉及费用),D5 源码快照保留策略(默认保留最近 10 个 commit,LRU 清理)。我的任务 T-205:演示环境调高 `RATE_LIMIT_NEW_REPOS_PER_HOUR`(建议 50)并预先分析 hono、zustand、zod、trpc,但我的电脑上没有 Docker 和 MySQL,只有 Redis,这一步需要一台能跑 compose 的环境,待确认放在哪里;trpc 能否分析成功第 1 周没测过。
- 2026-10-29 14:1x:#34 合并(T-203,提交 d584af2)、#35 合并(T-220,提交 234143a)。我在 #34 最新提交 c9b7c45 与 #35 最新提交 45c4902 上串行独立重跑 install、lint、typecheck、build、test(web 分别为 66 和 68)全过,`ci` 与 `smoke` 都绿,#34 合入后 #35 与 main 试合并无冲突。#34:删掉 `state.ts` 里的 `cycles`/`mergeCycles` 和 `GraphView.tsx` 传 `meta.cycles` 的两处,修正 `toFlow.ts` 过时注释,行为不变,`packages/shared` 未动。#35:聚合边默认透明度 0.3,线宽上限 8 改为 5,×N 标签在缩放低于 0.9 时隐藏;选中节点相关的边和环边不调淡且始终显示标签,不隐藏任何边;hono 首屏 ×N 标签从 40 个降到 0 个,选中 middleware 显示 11 个。后续项(非阻塞):`toFlow.ts` 的 `edgeWidth` 上方还留着旧的「上限 8px」注释,T-221 顺手删;环边不调淡只有单元测试覆盖(`d:src` 没有环边);透明度 0.3 在投影仪上可能过淡,上投影前准备 0.3 与 0.4 两档截图,由 Eva 现场选;暗色、Safari、Firefox、投影仪、大图性能、缩放 0.9 以上和 zustand 的截图未验证。T-205 拆成两步:架构师在自己电脑上单独干跑 analyzer(不起 compose)确认 trpc 能否分析、耗时和节点规模,并补 `scripts/demo-prep.sh`;真正的预分析仍待 Eva 的演示机或能跑 compose 的环境,不算已完成。#36(T-210 第一步:LLM 接口、`FakeLlm`、记账、响应缓存、预算熔断,预算定为每任务 $0.30、全站每天 $5)待评审。
- 2026-10-29 14:2x:#36 合并(T-210 第一步,提交 dffe323)。我在最新提交 50f1aff 上串行独立重跑 install、lint、typecheck、build、test(共 221 个,真实 Redis 与 MariaDB 上跑,未跳过)全过,`ci` 与 `smoke` 绿,与 main 试合并无冲突。内容:LLM 客户端接口与确定性 `FakeLlm`;价格表按每百万 token 美元计,费用按 micro-USD 向上取整;缓存命中(费用 0)和失败调用(`ok=0`)也写 `llm_usage`;响应缓存;日预算 $5(Redis key 按 UTC 日期分桶,UTC 零点自动重置)与单任务预算 $0.30(架构师裁定,取代设计文档的 $0.50),超限抛 `BUDGET_EXCEEDED`(`retryable:false`),不调模型、不记账,缓存仍可用;降级方案为剩余文件改用规则摘要、发一次 `stage_error`、任务仍完成并保留图和 embedding。`LLM_PROVIDER` 目前只接受 `fake`,真实供应商等 Eva 确认 D1。已知局限:检查与累加不是原子的,并发时最多超出(并发数减 1)次调用的花费。后续项(非阻塞):`readLlmConfig` 还没有被 api 或 worker 调用,「配置非法则启动失败」要等 T-211 接入才生效;缺「过 UTC 零点后恢复」的端到端测试;缓存内容损坏时 `JSON.parse` 会抛异常、没有降级;写缓存、写用量、累加花费不在同一个事务里;`dailyBudgetCents=0` 表示禁止调用而不是不限额,文档里要写明。#37(T-205 干跑与 `demo-prep.sh`)待评审,需先合并最新 main 解决冲突。
- 2026-10-29 14:3x:#37 合并(T-205 第一步,提交 b88dd7a)。我在最新提交 50994c3 上串行独立重跑 install、lint、typecheck、build、test 全过,`shellcheck` 0 警告,`ci` 与 `smoke` 绿,与当时 main 试合并无冲突。我在自己的环境里对 zustand(382d29c)和 trpc(708753f)重跑 analyzer 干跑,节点与边数和 PR 记录完全一致(zustand 23 节点 23 边,trpc 348 节点 795 边 1 个环),trpc 能分析成功。注意口径:这只证明 analyzer 能分析四个仓库,不含克隆、入库、SSE;**预分析尚未在真实环境执行**,`scripts/demo-prep.sh` 只验证了失败路径(死端口返回 HTTP 000、退出码 1),成功路径与轮询未在真实 API 上跑过,仍需 Eva 的演示机或能跑 compose 的环境。后续项(非阻塞):脚本没有用 `ref` 固定 commit,设计文档要求演示仓库固定 commitSha;curl 没设 `--max-time`,轮询失败被吞;提交返回 200 但没有 repoId 时会空等到超时;成功行只打印根层节点数、没有 commitSha。

## 演示检查清单(第 4 周前逐项勾选)
- 演示前提前分析好 hono、zustand、zod、trpc,演示时只走「复用已有结果」的路径,现场不依赖新分析。
- 演示环境把 `RATE_LIMIT_NEW_REPOS_PER_HOUR` 调高(默认 5),避免彩排几次后被限流;同时确认 `RATE_LIMIT_SUBMITS_PER_HOUR`(默认 60)够用。
- 状态栏的节点数和边数口径要和画布一致,避免被现场对数字(见 2026-10-29 的 84 与 80 讨论)。
- 暗色、Safari、Firefox、投影仪、大图性能还没验证,演示前在真实设备上过一遍。

### T-205 预分析(2026-10-29)
**预分析尚未在真实环境执行,需要能跑 compose 的演示机。** 下表是不起 compose、直接调用 `packages/analyzer`(`scanRepo` + `analyzeRepo`,与 worker parsing 阶段同一入口,按 worker 默认 `MAX_REPO_MB=300`、`MAX_FILES=5000` 判断)对 `--depth 1` 浅克隆的干跑结果,Node 20.20.2,架构师本机。

| 仓库 | commit | 结果 | 耗时 | 工作区 | 文件 | 节点(module/dir/file) | 边 | 跨模块聚合对 | cycles | unresolved | 布局规则 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| honojs/hono | ed1d5f7 | 成功 | 0.86s | 4.8MB | 240 | 338(9/89/240) | 607 | 0 | 5 | 27 | workspace |
| pmndrs/zustand | 382d29c | 成功 | 0.18s | 2.0MB | 18 | 23(4/1/18) | 23 | 5 | 0 | 2 | src-subdir |
| colinhacks/zod | b1f6ba0 | 成功 | 0.61s | 14.8MB | 175 | 196(6/15/175) | 476 | 4 | 1 | 28 | workspace |
| trpc/trpc | 708753f | 成功 | 0.64s | 7.2MB | 267 | 348(9/72/267) | 795 | 16 | 1 | 50 | workspace |

说明:耗时只含扫描和解析,不含克隆、入库、SSE;「边」是入库的 file→file 原始边;「跨模块聚合对」是两端上卷到不同 module 的 (源, 目标) 去重数,近似根层聚合边,API 实际投影以 `projection.ts` 为准。四个仓库都没触发 300MB / 5000 文件上限,monorepo 与路径别名没有导致失败;unresolved 未逐条核对。

脚本用法(需 api + worker + MySQL + Redis 已运行,api 以 `RATE_LIMIT_NEW_REPOS_PER_HOUR>=50` 启动):

```bash
API_BASE=http://localhost:4000 TIMEOUT_MIN=15 bash scripts/demo-prep.sh
```

依次 `POST /api/repos` 提交四个仓库,轮询 `GET /api/repos/:id` 到 `done`/`failed`/超时,打印耗时、文件、模块、边和根层节点数;任一失败非零退出。脚本只做过 `bash -n` 与 shellcheck 检查,没有对真实 API 运行过。
