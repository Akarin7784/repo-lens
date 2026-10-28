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
| T-003 | API 与 Worker:`POST /api/repos`、任务 SSE、clone 与文件树 | 后端与AI设计师 | 开发中(基于 #7) | - |
| T-004 | Web:设计令牌、首页、基于 fixture 的图渲染(React Flow + elkjs) | 前端可视化设计师 | 已合并 | [#8](https://github.com/Akarin7784/repo-lens/pull/8) |
| T-005 | CI 冒烟任务:真实构建镜像、起 compose、请求 `/health` | 架构师 | 已合并 | [#9](https://github.com/Akarin7784/repo-lens/pull/9) |

## 第 1 周未验证项
- ✅ 已验证(T-005,PR #9,[CI run](https://github.com/Akarin7784/repo-lens/actions/runs/40759576746)):镜像构建和 `docker compose up`,api `/health` 返回 `status:ok`,web 返回 200。
- ✅ 已处理(T-005):本机 Node 24 与 CI、Dockerfile 的 Node 20 不一致,CI、三个 Dockerfile、`.nvmrc` 和 `engines` 均固定 20,README 已说明差异,并要求提交前用 Node 20 跑一遍测试。
- ✅ 已验证(T-005,PR #9,[CI run](https://github.com/Akarin7784/repo-lens/actions/runs/40759576746)):Docker 镜像内 `tree-sitter`(0.22.4,原生绑定)能安装并运行,worker 镜像内用 TypeScriptAnalyzer 解析示例 TS(2 文件、3 节点、1 条边、0 语法错误)。
- 语法错误文件数(tree-sitter-typescript 不支持部分语法):zustand 5 个、hono 8 个(共 450 个文件)、zod 4 个(共 522 个文件)。import 仍能提取,只影响这些文件的符号和切块。

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
