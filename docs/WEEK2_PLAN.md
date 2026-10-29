# 第 2 周任务拆分(W2)

> 维护:架构师。基于 main `f502bd8`(2026-10-29)。时间为北京时间。
> 每个任务对应一个 PR,PR 标题带任务编号。验收以 CI 的 `ci` / `smoke` 或手动演示为准,写不进 CI 的标「手动」。

## 0. 范围依据与口径冲突

三份文档对 W2 的说法不完全一致:

| 来源 | W2 内容 |
|---|---|
| `ARCHITECTURE.md` §7(**以此为准**) | 模块聚类;LLM 自底向上摘要;模块↔文件下钻;节点详情面板、搜索、高亮、循环依赖标红;MySQL 持久化与缓存复用 |
| `PROGRESS.md` 里程碑表 | 分层摘要、节点详情、Qdrant 索引 |
| `BACKEND_AI_DESIGN.md` §11 | 摘要 + 切块 + Qdrant + 混合检索 + `/chat` + 引用校验 v1 |

**裁定**:W2 = ARCHITECTURE §7 的 W2 + 「切块写入 Qdrant」(只建索引,不做检索和问答)。混合检索、`/chat`、Agent、引用校验仍在 W3(与 ARCHITECTURE §7 一致)。`BACKEND_AI_DESIGN.md` §11 的周次在 T-209 里对齐。

### 代码现状(main 上实际存在的)
- worker 流水线:`summarizing`、`embedding` 两个阶段是桩(`apps/worker/src/pipeline/run.ts` 第 261-263 行,只发进度)。
- 表 `summary` 已建(level: function/file/dir/repo,`input_hash`、`model`、tokens),`llm_usage` 已建(purpose 含 summary/embed);尚无读写代码。
- `GET /api/repos/:id/nodes/*` 已存在,`summary` 恒为 `null`(`apps/api/src/projection.ts`)。
- `GET /api/repos/:id/files` **不存在**;`/chat` **不存在**(`packages/shared/src/chat.ts` 只有类型)。
- `packages/rag`、`packages/agent` 只有占位导出;Tree-sitter 已产出 `chunks`(按符号的行区间,`packages/analyzer/src/typescript/treesitter.ts`),尚未落库。
- compose 已有 `qdrant/qdrant:v1.12.4`,无代码连接它。
- 模块划分:`packages/analyzer/src/graph/modules.ts` 按 workspace / `src/` 下一级目录 / 根下一级目录,**没有 Louvain**。
- 前端:单击选中高亮一跳邻居已有;右栏详情、搜索、悬停、Shiki、`?node=` 未实现。环边改读 `inCycle` 在 #32(待合并)。
- 同 commit 复用:`POST /api/repos` 已有复用逻辑(`app.ts` 第 137 行);「< 1s 返回」没有 CI 断言。

## 1. Week1 遗留小项(W2 第一天清掉)

| 编号 | 负责 | 内容 | 验收 | 依赖 |
|---|---|---|---|---|
| T-201 | 架构师 | smoke 补 400 断言:`GET /api/repos/:id/graph?_t=1` 与非法 `parentId` 返回 400 `BAD_REQUEST` JSON;`POST /api/repos` 缺 `repoUrl` 返回 400 `BAD_REQUEST`,非法地址返回 `INVALID_REPO_URL` | CI `smoke` 绿,日志有 `SMOKE bad_request PASS` | 无 |
| T-202 | 架构师 | smoke 的聚合边断言放宽:`inside !== 1` 改为「至少一端 parentId===P」,并新增 hono `d:src/jsx` 展开断言(有 `inCycle:true` 的边,端点都在 nodes 内)。hono 克隆较慢,若 smoke 超时则只保留规则放宽,hono 断言改为手动(待确认) | CI `smoke` 绿 | #32 合并不是前提(只测 API) |
| T-203 | 前端设计师 | 删除 `meta.cycles` 收集代码和 `cycleEdgeKeys` 相关测试(#32 之后已不影响绘制) | `ci` 绿;`rg cycleEdgeKeys apps/web` 无结果 | #32 合并 |
| T-204 | 架构师 | `ARCHITECTURE.md` §6.1 下方去掉「PR #22 合并后」的限定(#22 已于 e1c9d1a 合并),改为现在时;顺带修 `limits.ts` 与 `.env.example` 注释里的 `POST /api/analyze` → `POST /api/repos` | `ci` 绿;文档 diff 只有这几处 | 无 |
| T-205 | 面试助手 | 演示环境:`.env` 里调高 `RATE_LIMIT_NEW_REPOS_PER_HOUR`(建议 50),预先分析 hono、zustand、zod、trpc 并记录 repoId/commitSha 到 `PROGRESS.md` 演示检查清单;确认重复提交走复用路径 | 手动:四个仓库再次提交都直接返回已有结果、不入队 | 无(trpc 能否分析成功**待确认**,W1 未测过) |

## 2. W2 主线任务

### 后端与 AI

| 编号 | 负责 | 内容 | 依赖 | 验收 | 不做什么 |
|---|---|---|---|---|---|
| T-210a | 后端与AI设计师 | **LLM 接口、FakeLlm、记账与预算熔断**(第一步,已由 #36 合并):`packages/agent` 的 `LlmClient` 接口、`FakeLlm`、`llm_usage` 记账、`DAILY_LLM_BUDGET_CENTS` / `LLM_TASK_BUDGET_CENTS` 熔断,`readLlmConfig` 目前只接受 `LLM_PROVIDER=fake` | 无 | 已合并(#36) | 不接真实接口 |
| T-210b | 后端与AI设计师 | **真实 OpenAI 兼容客户端(DeepSeek)+ 手动冒烟脚本**(第二步):`readLlmConfig` 接受 `LLM_PROVIDER=deepseek`,读 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`(默认 `https://api.deepseek.com`)和模型 id;provider=deepseek 而缺 key 时启动报错(错误信息不得含 key);按 DeepSeek 官方文档核对价格表和 usage 字段(含缓存命中计费字段),在 PR 里写明文档链接与核对日期;另附手动冒烟脚本(发一次极短请求,只打印 model、tokens、费用,不打印 key) | T-210a、D1 | 单测只用 mock HTTP,**不调真实接口**,CI 不放 key;手动:冒烟脚本在 box 上跑通一次,PR 贴脱敏输出 | 不做多供应商自动切换、重排、流式(W3);不在代码里硬编码未核对的价格 |
| T-211 | 后端与AI设计师 | **分层摘要(file → dir → module → repo)**:实现 worker 的 `summarizing` 阶段,写 `summary` 表,`input_hash` 复用;fanIn 前 200 个文件做文件摘要,其余只做规则摘要(文件名+导出名);失败发 `stage_error`,图照常可用 | T-210 | smoke 在 `FakeLlm` 下跑通:`done` 之后 `GET /nodes/m:src/middleware` 的 `summary` 非空;同 commit 重跑不新增 `llm_usage` 记录;手动:hono 用真实模型跑一次,记录成本和耗时 | 不做 function 层摘要(列为可选,时间够再加);不做增量(W3) |
| T-212 | 后端与AI设计师 | **节点详情接口补全**:`/nodes/*` 返回真实 `summary`、`exports`、`inDegree/outDegree`、`topDependents`、`inCycle`(以 shared 现有字段为准,缺的字段先改 shared,只增不减) | T-211(summary 部分);其余字段可先做 | `ci` 中 api 测试覆盖;smoke 断言 file 节点有 `loc`、度数 | 不做 `/chat` |
| T-213 | 后端与AI设计师 | **代码预览接口** `GET /api/repos/:id/files?path=&start=&end=`:路径规范化、拒绝 `..` 和符号链接、单次 ≤ 2000 行;源码来自 worker 保留的快照目录(保留策略见决策 D5) | D5 | api 测试覆盖 `..` 返回 400;smoke 读 zustand `src/vanilla.ts` 前 20 行成功 | 不做语法高亮(前端 Shiki) |
| T-214 | 后端与AI设计师 | **切块写入 Qdrant**:实现 `embedding` 阶段,用 analyzer 已有的 `chunks` 生成 payload(path、startLine、endLine、symbol、contentHash),写 `QDRANT_COLLECTION`;embedding 按 contentHash 缓存 | T-210;决策 D3、D4 | smoke 中 qdrant 健康、zustand 分析后 collection 点数 > 0(CI 用 FakeEmbedding 固定向量);手动:hono 真实 embedding 一次,记成本 | 不做 BM25、RRF、检索 API(W3) |
| T-215 | 后端与AI设计师 | **模块聚类评估**:用 zustand/hono/zod 现有 module 划分出一份人工评审表;只有当目录 > 40 时才实现 Louvain 合并(ARCHITECTURE §4.1 第 5 条)。三个仓库若都不触发,本任务只交评审文档 | 无 | 架构师评审通过「模块划分合理」;若实现 Louvain,有单测且失败回退纯目录分组 | 不改已有 module id 规则(会让前端缓存和 smoke 失效) |
| T-216 | 后端与AI设计师 | **复用耗时验证**:smoke 第二次提交同一 commit,断言 < 1s 返回且不入队 | 无 | CI `smoke` 绿,日志打印耗时 | 不做增量分析 |

### 前端

| 编号 | 负责 | 内容 | 依赖 | 验收 | 不做什么 |
|---|---|---|---|---|---|
| T-220 | 前端设计师 | **连线降噪 A+C**:聚合边默认调淡(透明度约 0.3,线宽上限降低),zoom < 约 0.9 时隐藏 ×N(选中相关边例外),先统计 hono/zustand weight 分布定系数 | #32 合并 | `ci` 绿;手动:hono 60 节点/156 边浅色深色截图,投影仪上线可见(数值可调到 0.35–0.4) | 不隐藏任何边 |
| T-221 | 前端设计师 | **悬停预览 B**:悬停节点 ~120ms 防抖后按选中样式高亮,选中优先于悬停 | T-220(同文件,串行避免冲突) | 单测覆盖进入/离开/选中优先;手动演示 | 不做触屏替代 |
| T-222 | 前端设计师 | **右栏节点详情 `<NodeDetail>`**:路径面包屑、类型、摘要(null 时骨架屏,收到 `done` 后重取)、指标、依赖/被依赖列表可点跳转;`?node=` 写入 URL | T-212(可先对 mock 开发) | 单测;手动:hono 点 `d:src/middleware` 看到摘要 | 不做「问问这个模块」按钮的实际对话(W3,先放禁用态或不放) |
| T-223 | 前端设计师 | **Shiki 代码预览**:file 节点详情里懒加载 `/files`,支持行区间高亮(W3 引用复用) | T-213、T-222 | 单测;手动:浅色/深色主题各截图 | 不做 >2000 行虚拟滚动以外的编辑功能 |
| T-224 | 前端设计师 | **搜索**:按路径模糊搜索已加载节点;命中未加载的节点时按 parentId 链逐层展开(复用 suggestedFocus 的展开逻辑) | T-222 可并行 | 单测覆盖「未加载节点逐层展开」;手动:hono 搜 `compose.ts` 定位 | 不做全文/代码内容搜索(W3 RAG) |
| T-225 | 前端设计师 | (可选 D)「只显示 weight≥k 的聚合边」开关,默认 k=1,状态栏写「已隐藏 N 条」 | T-220 投屏验收后仍太乱才做 | 默认不隐藏数据;单测 | — |

### 架构师 / 面试助手

| 编号 | 负责 | 内容 | 依赖 | 验收 |
|---|---|---|---|---|
| T-209 | 架构师 | 文档对齐:`PROGRESS.md` W2/W3 描述、`BACKEND_AI_DESIGN.md` §11 周次与本计划一致;摘要和 Qdrant payload 的 shared 类型评审 | 本 PR 合并 | `ci` 绿 |
| T-230 | 面试助手 | 每个 PR 复验(串行跑测试)、合并、记 `PROGRESS.md`;W2 周末跑一次 hono 真实模型全链路,记录分析成本和耗时 | — | `PROGRESS.md` 有成本数字 |

## 3. 执行顺序与并行

```
第 1 天:T-201 T-202 T-204(架构师) ‖ T-203 T-220(前端,#32 合并后) ‖ T-210b(后端) ‖ T-205(面试助手)
第 2-3 天:T-211 → T-212(后端) ‖ T-221 → T-222(前端,先对 mock) ‖ T-213(后端,与 T-211 并行)
第 4 天:T-214(后端) ‖ T-223 T-224(前端) ‖ T-216
第 5 天:T-215 评审、T-225(可选)、T-209 文档对齐、周末全链路(T-230)
```
- 关键路径:T-210b → T-211 → T-212 → T-222(右栏摘要)。
- 前端 T-220、T-221 改同一组文件(`WeightedEdge.tsx`、`selection.ts`),串行。
- shared 类型改动(T-212、T-214)先单独小 PR 合并,前后端再并行。

## 4. 需要提前拍板的架构决策(附我的默认值)

| # | 决策 | 我的建议默认值 | 状态 |
|---|---|---|---|
| D1 | LLM 供应商与模型 | **已决:DeepSeek**(Eva 2026-10-29 决定)。模型 id `deepseek-flash`(显示名 DeepSeek-V4.1-Flash),上下文 1048576、最大输出 393216,输入文字和图片、输出仅文字;走 OpenAI 兼容接口,base URL 默认 `https://api.deepseek.com`,可用 `DEEPSEEK_BASE_URL` 覆盖;key 只从环境变量 `DEEPSEEK_API_KEY` 读取,不进仓库、PR、日志。摘要与问答是否都用 `deepseek-flash` 由 T-210b 定。注意:上下文大不等于便宜,摘要仍按 D8 控制输入量(导出签名 + 前 80 行、fanIn 前 200 文件)。价格和 usage 字段以 T-210b 核对的官方文档为准,本文不写价格 | 已决 |
| D2 | 成本上限 | 不变:`DAILY_LLM_BUDGET_CENTS=500`(每天 $5),`LLM_TASK_BUDGET_CENTS=30`(每任务 $0.30,超出后剩余文件只做规则摘要);CI 一律用 `LLM_PROVIDER=fake`,不调真实模型、不放 key;费用按 T-210b 核对的 DeepSeek 价格(含缓存命中价)计算 | 已决 |
| D3 | 向量库部署 | 沿用 compose 内 Qdrant v1.12.4,只走内网 6333,带 `QDRANT_API_KEY`;每个仓库 commit 用 payload 过滤(`repoId`+`commitSha`),共用一个 collection | 建议采纳 |
| D4 | embedding 模型与维度 | **已决(架构师,2026-10-29)**:本地 e5 + 中文查询改写 + 混合检索,验收见 T-214。沿用本地 ONNX `multilingual-e5-small`(384 维,fp32,不用 q8);中文问题先用 flash 改写成英文技术术语查询,再向量检索加关键词检索(RRF 融合)。实测(hono,240 文件、1434 切块):fp32 总耗时 92.5 s,峰值内存约 2.5 GB,模型 448.5 MiB;中文召回弱(6 题只有 2 题首条相关),所以需要上述方案。T-214 要求:查询加 `query: `、文档块加 `passage: ` 前缀并先重测;改写失败、超预算或熔断时降级为原问题直接检索;同一套 12 题在 hono 复测,另有留出集 `docs/RAG_HOLDOUT.md`(8 题,前 5 条命中不少于 6 题,调参结束后只跑一次;演示冒烟题 S1 单列不计入),调参题见 `docs/RAG_TUNING_QUESTIONS.md`;中文 6 题须同时满足前 5 条命中不少于 4 题、第 1 条相关不少于 3 题(实测基线为 2 题),英文不低于现在,结果摘要写进 `docs/`;达不到则启用回退(外部 embedding 服务,由架构师向 Eva 要服务商和 key;一旦启用,外发前必须经同一个敏感文件排除模块过滤,并与提交页、README 的第三方模型提示保持一致);embedding 限制在 worker 内,批大小可配置,演示机内存至少 4 GB | 已决 |
| D5 | 源码快照保留 | ARCHITECTURE §6.5 写「完成后删除工作目录」,但 `/files` 和 W3 引用校验需要原文。建议:按 `repoId-commitSha` 保留快照,只保留最近 N=10 个 commit,LRU 清理;或只为四个演示仓库保留(**待确认**) | 需拍板 |
| D6 | 摘要失败降级 | LLM 失败或 JSON 解析失败重试 1 次,再失败用规则摘要;整个 summarizing 失败只发 `stage_error`,任务仍 `done`,图可用 | 建议采纳 |
| D7 | 引用校验失败降级(W3 实现,W2 先定) | 沿用 ARCHITECTURE §8:失败引用丢弃并计 `done.droppedCitations`;一条都不过就重试一次,仍失败用检索 top 片段作引用并标 `fallback:"retrieval"` | 建议采纳 |
| D8 | 摘要范围 | W2 只做 file/dir/module/repo 四层,function 层推迟;fanIn 前 200 文件 | 建议采纳 |
| D9 | CI 是否联 Qdrant | smoke 起 qdrant 容器并断言写入点数(Fake 向量),不调用外部 embedding | 建议采纳 |

## 5. 未验证 / 待确认
- trpc 能否在现有限制(300MB、5000 文件、TS 识别)下分析成功:W1 未测。
- hono 加入 smoke 后的 CI 耗时:未测。
- 真实模型下 hono 的摘要成本与耗时:只有 ARCHITECTURE §6.4 的估算($0.05-0.15),无实测。
- 前端 edge-clutter 方案的透明度、阈值均未做原型实测(方案原文说明构建被拦,未运行)。
