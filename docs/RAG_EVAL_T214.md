# T-214 PR-2 检索评测结果(hono @ ed1d5f7)

运行于 2026-10-29(UTC+8),脚本 `scripts/rag-eval.mjs`。题目见 [`RAG_TUNING_QUESTIONS.md`](./RAG_TUNING_QUESTIONS.md) 与 [`RAG_HOLDOUT.md`](./RAG_HOLDOUT.md)(题目文件未改)。

- 环境:本地 ONNX `Xenova/multilingual-e5-small` fp32(本地模型目录,`allowRemoteModels=false`,不联网),1434 块,内存向量库;混合检索 = 向量 + 进程内 BM25 + 符号精确匹配,RRF k=60,取前 5。
- 改写:真实 DeepSeek(只读环境变量 `DEEPSEEK_API_KEY`,未打印),`purpose: chat`,提示词 `rw-1`,temperature 0;仅中文问题改写。
- 判定:调参题只有「参考」位置,按**文件**判定(`src/router/` 这类按目录前缀);留出集与 S1 按 RAG_HOLDOUT.md 判定(文件 + 所列符号,类切块覆盖其方法)。
- 对照基线:同一判定下「仅向量、原问题、不改写」的结果(脚本每题同时算出)。

## 调参题(12 题)

调参只改了判定口径之外的东西一次:首轮(脚本初版对调参题也按符号判定)中文 top5 6/6、top1 3/6,英文 top5 4/6、top1 1/6;改为按文件判定后为下表。检索参数(RRF k、路径/符号权重 ×3、候选数 50)与提示词 `rw-1` 未再改动。

| 组 | 前 5 命中 | 首位相关 | 仅向量基线 前 5 / 首位 | 目标 | 结论 |
|---|---|---|---|---|---|
| 中文 6 题 | 6/6 | 4/6 | 4/6 / 2/6 | ≥4/6、≥3/6 | 达标 |
| 英文 6 题 | 5/6 | 4/6 | 5/6 / 4/6 | 不低于改造前 | 与同口径基线持平(见下) |

英文说明:同一判定下仅向量基线的英文首位为 4/6(英2 首位是 `src/router.ts`,英3 首位是 `adapters/*/serve-static.ts`,都不在参考目录),不是 6/6;任务里「英文首位 6/6」的口径与本脚本判定是否一致 **未确认**。英3 前 5 由基线的命中变为未命中(前 5 全是各 adapter 的 `serveStatic`),英2 前 5 由未命中变为命中。

## 留出集(8 题,只跑一次)

**留出集合计:前 5 命中 4/8,未达标(达标线 6/8)。** 首位相关 3/8;同口径仅向量基线 1/8。

| # | 前 5 | 首位 | 说明 |
|---|---|---|---|
| H1 | 命中 | 是 | `compose.ts` `compose` |
| H2 | 未命中 | 否 | 首位 `src/jsx/context.ts`;`src/context.ts` 的 `Context` 未进前 5 |
| H3 | 命中 | 否 | |
| H4 | 未命中 | 否 | |
| H5 | 命中 | 是 | `bodyLimit` |
| H6 | 命中 | 是 | `requestId` |
| H7 | 未命中 | 否 | 首位是 `csrf/index.ts` 的 `CSRFOptions`,文件对但不是 `csrf` 符号,按判定不计 |
| H8 | 未命中 | 否 | |

留出集已用掉,按约束不再据此调参;后续改进需新的调参题或架构师决定。

## 演示冒烟题(不计分)

S1「路由匹配在哪个文件?」:前 5 未命中(首位 `src/router.ts` 的 `Router` 接口);仅向量基线前 5 命中。

## 改写调用次数与成本

| 运行 | 改写调用 | 费用(µUSD,按高峰价) |
|---|---|---|
| 调参第 1 轮 | 6 | 321 |
| 调参第 2 轮(改判定后) | 6 | 321 |
| 留出集 | 8 | 439 |
| S1 | 1 | 52 |
| 合计 | 21 | 1133(约 $0.0011) |

每次中文问答多一次改写调用,约 50–55 µUSD;英文问题不调用。网关缓存在本脚本中为进程内,跨运行不复用。

## 模型与联网

- 运行时:`OnnxEmbedder` 设 `allowRemoteModels=false`,只读 `EMBEDDING_MODEL_DIR`,不访问网络/CDN(代码确认)。
- 镜像:`apps/worker/Dockerfile` 在**构建阶段**按固定 revision 下载 5 个文件并 `sha256sum -c` 校验,打进镜像 `/app/models`;运行时不再下载。构建机需要能访问 huggingface.co 或镜像站。
- 本次评测用的是本机已下载的模型目录:其中 `onnx/model.onnx` 的 sha256 与 Dockerfile 固定值一致(已比对);其余 4 个小文件未比对(**未确认**)。

## S1 诊断(2026-10-29 17:2x UTC+8,只诊断,未改检索代码)

命令:`node scripts/rag-eval.mjs diag-s1`(真实改写,key 只从环境变量读)。本次改写:`route matching router match routes router.ts`(约 51 µUSD)。注意 temperature 0 下改写在不同运行间也有细微差别(归因那次多了 `file`),脚本内缓存不跨进程。

各路 top10 里「首个 `src/router/` 下实现文件」名次 / S1 应命中 4 个文件的首个名次:

| 列表 | 首个 router/ 实现 | 首个 S1 应命中文件 | top1–3 |
|---|---|---|---|
| 向量(改写后) | 4 | 6(`reg-exp-router/matcher.ts` `match`) | `helper/route` `matchedRoutes`、`routePath`;`src/router.ts` 常量 |
| 向量(原问题,不改写) | 1 | 2(`matcher.ts` `MatcherMap`) | `linear-router` `splitPathRe`、`matcher.ts` ×2 |
| BM25(改写+原问题) | 3 | 12 | `helper/route` `matchedRoutes`、`src/router.ts` `Router`、`pattern-router` |
| BM25(仅原问题) | — | — | 空(中文无可用 token) |
| 精确匹配 | >10 | 23 | 全部是 `src/router.ts` 的符号 |
| RRF(改写) | 3 | 6(`smart-router/router.ts` `SmartRouter`) | `src/router.ts` ×2、`linear-router` |
| RRF(不改写,只有向量路) | 1 | 2 | 同向量(原问题) |

改写后 BM25 实际用到的 token(stem 后):`route, match, rout, match, rout, rout, t`。

原因(按影响大小):

1. **改写把查询拉向 `src/router.ts`(接口文件)**:改写输出里有 `router.ts`。精确匹配路按文件名命中,前 10 全是 `src/router.ts`;BM25 的路径 ×3 权重也把它抬高。三路都把 `src/router.ts` 排在前面,RRF 后它占了 1、2 位。这个文件只有 `Router` 接口和常量,不在 S1 应命中列表里。
2. **stem 把 route/router/routes 合成 `rout`,`.ts` 留下一个 `t`**:`helper/route/*`(`matchedRoutes`、`routePath`)和路由器实现分不开,一起挤进前列。
3. **RRF 压低**:向量(原问题)把 `matcher.ts` 排第 2,但关键词两路都没有它(BM25 12、精确 23),融合后掉出前 5。正确文件进了候选,是排序问题,不是召回问题。
4. **切块粒度与判定**:3 个 router 的 `match` 是类方法,整个类是一块(如 `SmartRouter` 4–70 行),没有名为 `match` 的单独块。另外 `linear-router`、`pattern-router` 也是真实的路由器实现,但不在 S1 应命中列表里,而 RRF 前 5 里有它们。按「仓库实际」它们也算路由匹配实现,S1 判定列表可能偏窄(**未确认**,由出题方定)。

结论:主要是 1+3(改写带出文件名 + 精确/路径权重把它放大,RRF 把只有向量路认的正确文件压下去),其次是 2。不是 embedding 召回问题。

修复建议(另开 PR,用绿色三角形出的新题复验,不用本留出集):
- 改写提示词不要求输出文件名;或精确匹配路忽略带扩展名的 token,和/或不对 path 做精确匹配。
- 精确匹配列表按文件去重,避免一个文件占满整路;RRF 可按路加权(向量路略高),或对精确路设上限。
- stem 不要把 `router` 合成 `route`;丢弃长度 1 的 token。
- 切块:大类按方法再切(至少给 `match` 这类方法单独成块)。

S1 已作为待修 bug 并入调参集记录(见 RAG_TUNING_QUESTIONS.md 末节),修复另开 PR。

## 归因(2026-10-29,只归因不调参)

命令:`node scripts/rag-eval.mjs attrib`。对象:留出集未命中的 H2、H4、H7、H8,S1,调参集未命中的英3。名次是在**完整排序**中的位置(1434 块),候选数与线上一致为 50,即名次 ≤50 算「进了候选」。「判定」= 按 RAG_HOLDOUT.md(文件+符号);「仅文件」= 只看文件。改写在本次重新调用了一次(与留出集那次的文本可能有细微差别)。

分类:A 改写没译对;B 没进候选(向量和 BM25 前 50 都没有);C 进了候选但排名低(融合/权重)。

| 题 | 改写后 query | 判定名次:向量(改写)/向量(原问题)/BM25/精确/RRF | 仅文件名次:同左 | 归类 | 理由 |
|---|---|---|---|---|---|
| 英3 | (英文不改写) | 5 / 5 / 11 / — / 9 | 同左 | C | 向量第 5,BM25 被各 adapter 的 `serveStatic` 占满前列,融合后掉到第 9 |
| H2 | `Context object purpose class Context context.ts usage` | 147 / 49 / 45 / 27 / 21 | 4 / 2 / 31 / 1 / 2 | C | `Context` 类块在 BM25、精确两路的前 50 里,但大类整块向量分数低;文件本身 RRF 第 2(命中的是同文件的类型块) |
| H4 | `middleware pass data between middleware context next ctx` | 27 / 878 / 23 / — / 16 | 27 / 2 / 6 / — / 16 | C | 目标块在向量和 BM25 前 50,融合后第 16。改写让文件级向量名次从 2 变 27,但目标块从 878 变 27,整体是改写有帮助,不归 A |
| H7 | `CSRF protection csrf token verifyCsrfToken middleware anti-CSRF` | 17 / 38 / 20 / — / 12 | 3 / 1 / 2 / — / 1 | C | 文件 RRF 第 1(`CSRFOptions`),`csrf` 函数块在各路前 20,融合后第 12 |
| H8 | `reusable typed middleware write custom middleware type generics middleware.ts` | 无 / 无 / 无 / — / 无 | 945 / 311 / 580 / — / — | B | **没有任何 `createMiddleware` 切块**:analyzer 对 `src/helper/factory/index.ts` 只切出 `InitApp`(18 行)、`CreateHandlersInterface`(20–25 行)两块,368 行的 `export const createMiddleware` 和 `Factory` 类没进切块;文件级也不在任何路前 50 |
| S1 | `route matching router match routes file router.ts` | 5 / 2 / 12 / 23 / 6 | 同左 | C | 见上节 S1 诊断:进了候选,被 `src/router.ts` 和 `helper/route` 压下去 |

汇总:**A 0 题,B 1 题(H8),C 5 题**(英3、H2、H4、H7、S1)。

结论倾向:**主要是排序/融合问题(C)**,不是 embedding 召回能力问题,暂不需要换外部 embedding。建议方向(另开 PR、用新题验证):本地调 RRF 各路权重与精确匹配路、改写提示词不带文件名、大类按方法切块。唯一的 B(H8)根因是 **analyzer 切块漏了文件后半部分的导出**(疑似遇到某个语法结构后停止产出切块,**未确认**具体原因),属于切块 bug,换 embedding 也解决不了,应单独修。

本节所有数字只用于选方向;按约束不据此调参,不把留出题措辞写入任何提示词或示例。

## T-214b 回归基线(2026-10-29,调参集 12 题 + S1)

命令:`EMBEDDING_MODEL_DIR=… node scripts/rag-eval.mjs tuning` 与 `… s1`,对象 hono ed1d5f7,判定沿用原有规则(调参集按文件 `fileLevel`,英文判定未放宽)。只跑调参集与 S1,未跑任何留出集。

| | 修复前 | 修复后 |
|---|---|---|
| CHUNKER_VERSION | 1 | 2 |
| EMBED_TEXT_VERSION | (未引入,等价 1) | 1 |
| 模型 | Xenova/multilingual-e5-small(revision 未入 digest) | Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78 |
| 改写提示词 | rw-1 | rw-2(temperature 0) |
| 切块数 | 1434 | 1604 |
| digest | — | 5aae128c2087 |
| 中文 top5 / top1 | 6/6 / 4/6 | **5/6** / 4/6 |
| 英文 top5 / top1 | 5/6 / 4/6 | 5/6 / 5/6 |
| S1 top5 / top1 | 0/1 / 0/1 | 0/1 / 0/1 |
| 费用(DeepSeek 改写) | 321 + 52 µUSD | 352 + 58 µUSD |

**结论:未达标。** 英文没有退化(top1 4/6→5/6,英2 改为 top1 命中),英文 top1 6/6 未达到(英3 仍未命中,前 5 被各 adapter 的 `serveStatic` 占满)。中文 top5 6/6→5/6 **退化**:中3 掉出前 5;中5 top1 退为未命中(仍在前 5)。两题修复前命中都依赖改写里的文件名/`router` 一词(rw-1 输出 `router`、`jwt.ts`,精确匹配路随之命中),rw-2 不再输出文件名后失去这条信号——这是本 PR 有意去掉的行为,但结果是退化,如实记录,**未在本 PR 里为这两题另行调参**。S1 仍未命中(前 5 里有 `src/router/pattern-router/router.ts`,但不是判定要求的 smart/reg-exp router 文件)。改写文本为真实 LLM 单次输出,未做多次采样,稳定性只由缓存保证。

逐题(改写文本与完整 top-5 路径):

- **中1 前** hit5=1 top1=1 rw=`CORS middleware setup configure corsMiddleware cross-origin headers`
  - top5: `src/middleware/cors/index.ts`, `src/middleware/cors/index.ts`, `src/middleware/secure-headers/secure-headers.ts`, `src/middleware/secure-headers/secure-headers.ts`, `src/middleware/timing/timing.ts`
- **中1 后** hit5=1 top1=1 rw=`CORS middleware setup configure corsOptions allowOrigin`
  - top5: `src/middleware/cors/index.ts`, `src/middleware/cors/index.ts`, `src/middleware/csrf/index.ts`, `src/middleware/csrf/index.ts`, `src/middleware/timing/timing.ts`
- **中2 前** hit5=1 top1=0 rw=`read JSON request body req.json parseBody request.ts`
  - top5: `src/utils/body.ts`, `src/request.ts`, `src/request.ts`, `src/request.ts`, `src/request.ts`
- **中2 后** hit5=1 top1=1 rw=`read JSON request body parseBody req body json`
  - top5: `src/request.ts`, `src/utils/body.ts`, `src/request.ts`, `src/utils/body.ts`, `src/request.ts`
- **中3 前** hit5=1 top1=0 rw=`route params parse parseParams routeParams router`
  - top5: `src/router.ts`, `src/router/pattern-router/router.ts`, `src/router/linear-router/router.ts`, `src/router.ts`, `src/router.ts`
- **中3 后** hit5=0 top1=0 rw=`route params parse parseParams routeParams extract`
  - top5: `src/types.ts`, `src/types.ts`, `src/types.ts`, `src/router.ts`, `src/router.ts`
- **中4 前** hit5=1 top1=1 rw=`streaming response return streamResponse stream.ts`
  - top5: `src/helper/streaming/stream.ts`, `src/helper/streaming/stream.ts`, `src/helper/streaming/text.ts`, `src/utils/stream.ts`, `src/helper/streaming/sse.ts`
- **中4 后** hit5=1 top1=1 rw=`streaming response return streamResponse createStream sendStream`
  - top5: `src/helper/streaming/sse.ts`, `src/helper/streaming/stream.ts`, `adapters/aws-lambda/src/handler.ts`, `src/adapter/aws-lambda/handler.ts`, `src/utils/stream.ts`
- **中5 前** hit5=1 top1=1 rw=`JWT authentication middleware verify token verifyToken auth middleware jwt.ts`
  - top5: `src/middleware/jwt/jwt.ts`, `src/middleware/jwt/jwt.ts`, `src/middleware/jwt/jwt.ts`, `src/utils/jwt/jwt.ts`, `src/utils/jwt/jwt.ts`
- **中5 后** hit5=1 top1=0 rw=`JWT authentication middleware verify token verifyToken authenticate`
  - top5: `src/utils/jwt/jwt.ts`, `src/middleware/jwt/jwt.ts`, `src/middleware/bearer-auth/index.ts`, `src/middleware/jwt/jwt.ts`, `src/utils/jwt/jwt.ts`
- **中6 前** hit5=1 top1=1 rw=`set get cookie document.cookie cookies.ts`
  - top5: `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`
- **中6 后** hit5=1 top1=1 rw=`set get cookie document.cookie setCookie getCookie`
  - top5: `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`, `src/adapter/aws-lambda/handler.ts`, `adapters/aws-lambda/src/handler.ts`
- **英1 前** hit5=1 top1=1 rw=`how to set up basic auth middleware`
  - top5: `src/middleware/basic-auth/index.ts`, `src/middleware/basic-auth/index.ts`, `src/middleware/jwt/jwt.ts`, `src/middleware/jwk/jwk.ts`, `src/utils/basic-auth.ts`
- **英1 后** hit5=1 top1=1 rw=`how to set up basic auth middleware`
  - top5: `src/middleware/basic-auth/index.ts`, `src/middleware/basic-auth/index.ts`, `src/middleware/jwt/jwt.ts`, `src/middleware/jwk/jwk.ts`, `src/utils/basic-auth.ts`
- **英2 前** hit5=1 top1=0 rw=`where are route parameters matched in the router`
  - top5: `src/router.ts`, `src/helper/route/index.ts`, `src/helper/route/index.ts`, `src/helper/route/index.ts`, `src/router/reg-exp-router/prepared-router.ts`
- **英2 后** hit5=1 top1=1 rw=`where are route parameters matched in the router`
  - top5: `src/router/pattern-router/router.ts`, `src/router.ts`, `src/helper/route/index.ts`, `src/router/linear-router/router.ts`, `src/helper/route/index.ts`
- **英3 前** hit5=0 top1=0 rw=`how to serve static files`
  - top5: `adapters/bun/src/serve-static.ts`, `src/adapter/bun/serve-static.ts`, `adapters/cloudflare-workers/src/serve-static.ts`, `adapters/cloudflare-workers/src/serve-static.ts`, `src/adapter/cloudflare-workers/serve-static.ts`
- **英3 后** hit5=0 top1=0 rw=`how to serve static files`
  - top5: `adapters/bun/src/serve-static.ts`, `src/adapter/bun/serve-static.ts`, `adapters/cloudflare-workers/src/serve-static.ts`, `adapters/cloudflare-workers/src/serve-static.ts`, `src/adapter/cloudflare-workers/serve-static.ts`
- **英4 前** hit5=1 top1=1 rw=`how does the app handle errors and not found`
  - top5: `src/hono-base.ts`, `src/compose.ts`, `src/compose.ts`, `src/middleware/combine/index.ts`, `src/types.ts`
- **英4 后** hit5=1 top1=1 rw=`how does the app handle errors and not found`
  - top5: `src/hono-base.ts`, `src/context.ts`, `src/hono-base.ts`, `src/compose.ts`, `src/compose.ts`
- **英5 前** hit5=1 top1=1 rw=`compress response with gzip`
  - top5: `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/serve-static/index.ts`
- **英5 后** hit5=1 top1=1 rw=`compress response with gzip`
  - top5: `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/serve-static/index.ts`
- **英6 前** hit5=1 top1=1 rw=`validate request body with a validator`
  - top5: `src/validator/validator.ts`, `src/validator/validator.ts`, `adapters/lambda-edge/src/handler.ts`, `src/adapter/lambda-edge/handler.ts`, `src/helper/proxy/index.ts`
- **英6 后** hit5=1 top1=1 rw=`validate request body with a validator`
  - top5: `src/validator/validator.ts`, `src/validator/validator.ts`, `src/request.ts`, `src/request.ts`, `src/request.ts`
- **S1 前** hit5=0 top1=0 rw=`route matching router match routes file router.ts`
  - top5: `src/router.ts`, `src/router.ts`, `src/router/linear-router/router.ts`, `src/router/pattern-router/router.ts`, `src/router/pattern-router/router.ts`
- **S1 后** hit5=0 top1=0 rw=`route matching router matchRoutes findRoute resolvePath`
  - top5: `src/router/pattern-router/router.ts`, `src/helper/route/index.ts`, `src/helper/route/index.ts`, `src/router.ts`, `src/request.ts`

### rw-3(2026-10-29,架构师裁定的单轮,只改改写提示词)

**rw-3 是对着调参集迭代出来的,调参集和 S1 的数字已不是独立验收,唯一的独立检验是之后跑一次 holdout v2。**

版本:chunker=2,embedText=1,模型 Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78,提示词 rw-3,digest 5aae128c2087(与 rw-2 相同,向量复用)。提示词新增规则:保留主题的通用类别词及其标识符形态(名词、复数、-er/-or 施事名词、PascalCase 类名),仍禁止文件名;示例换为购物车、日志两个与评测无关的领域;提示词不含评测题涉及的具体词(有测试)。判分规则不变,只跑调参集 12 题 + S1。

| | rw-2 | rw-3 |
|---|---|---|
| 中文 top5 / top1 | 5/6 / 4/6 | 6/6 / 4/6 |
| 英文 top5 / top1 | 5/6 / 5/6 | 5/6 / 5/6 |
| S1 top5 / top1 | 0/1 / 0/1 | 1/1 / 1/1 |
| 改写费用 | 352 + 58 µUSD | 458 + 75 µUSD |

合并条件(中文前5 ≥5/6;英文前5 ≥5/6 且首位 ≥4/6):**达到**。英文不改写,检索结果与 rw-2 完全一致。英3 仍未命中。改写只采样一次。

逐题:

- **中1** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。命中状态不变,前 5 顺序/成员有变化。
  - rw-3 改写:`CORS cross origin middleware Middleware setCors corsOptions configure`
  - rw-3 top5: `src/middleware/cors/index.ts`, `src/middleware/cors/index.ts`, `src/middleware/secure-headers/secure-headers.ts`, `src/middleware/timing/timing.ts`, `src/middleware/secure-headers/secure-headers.ts`
- **中2** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。命中状态不变,前 5 顺序/成员有变化。
  - rw-3 改写:`request body JSON parse readBody getBody jsonBody RequestBody`
  - rw-3 top5: `src/request.ts`, `src/utils/body.ts`, `src/request.ts`, `adapters/lambda-edge/src/handler.ts`, `src/utils/body.ts`
- **中3** rw-2 hit5=0 top1=0 → rw-3 hit5=1 top1=0。rw-3 保留类别词与标识符形态(route/router/params),精确与关键词路重新覆盖 src/router/ 下文件,回到前 5;首位仍是非判定文件。
  - rw-3 改写:`route routes router Router param params parseRoute parseParams parameter parsing`
  - rw-3 top5: `src/router.ts`, `src/router.ts`, `src/router.ts`, `src/router/reg-exp-router/matcher.ts`, `src/router.ts`
- **中4** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。命中状态不变,前 5 顺序/成员有变化。
  - rw-3 改写:`streaming response stream Stream returnStream streamResponse SSE chunk`
  - rw-3 top5: `src/helper/streaming/sse.ts`, `src/helper/streaming/index.ts`, `src/helper/streaming/text.ts`, `src/helper/streaming/sse.ts`, `src/helper/streaming/sse.ts`
- **中5** rw-2 hit5=1 top1=0 → rw-3 hit5=1 top1=1。改写带回 `JWT`、`jwtMiddleware` 等标识符形态,首位回到 src/middleware/jwt/jwt.ts。
  - rw-3 改写:`JWT authentication auth middleware verifyToken token validation jwtMiddleware`
  - rw-3 top5: `src/middleware/jwt/jwt.ts`, `src/utils/jwt/jwt.ts`, `src/middleware/jwt/jwt.ts`, `src/middleware/bearer-auth/index.ts`, `src/middleware/jwt/jwt.ts`
- **中6** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=0。改写多了 `set get read` 等泛词,首位被其他文件占去,首位由命中变未命中(仍在前 5)。
  - rw-3 改写:`cookie cookies setCookie getCookie readCookie Cookie set get read`
  - rw-3 top5: `adapters/aws-lambda/src/handler.ts`, `src/helper/cookie/index.ts`, `src/adapter/aws-lambda/handler.ts`, `src/helper/cookie/index.ts`, `src/helper/cookie/index.ts`
- **英1** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。无变化
  - rw-3 改写:`how to set up basic auth middleware`
  - rw-3 top5: `src/middleware/basic-auth/index.ts`, `src/middleware/basic-auth/index.ts`, `src/middleware/jwt/jwt.ts`, `src/middleware/jwk/jwk.ts`, `src/utils/basic-auth.ts`
- **英2** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。无变化
  - rw-3 改写:`where are route parameters matched in the router`
  - rw-3 top5: `src/router/pattern-router/router.ts`, `src/router.ts`, `src/helper/route/index.ts`, `src/router/linear-router/router.ts`, `src/helper/route/index.ts`
- **英3** rw-2 hit5=0 top1=0 → rw-3 hit5=0 top1=0。无变化
  - rw-3 改写:`how to serve static files`
  - rw-3 top5: `adapters/bun/src/serve-static.ts`, `src/adapter/bun/serve-static.ts`, `adapters/cloudflare-workers/src/serve-static.ts`, `adapters/cloudflare-workers/src/serve-static.ts`, `src/adapter/cloudflare-workers/serve-static.ts`
- **英4** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。无变化
  - rw-3 改写:`how does the app handle errors and not found`
  - rw-3 top5: `src/hono-base.ts`, `src/context.ts`, `src/hono-base.ts`, `src/compose.ts`, `src/compose.ts`
- **英5** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。无变化
  - rw-3 改写:`compress response with gzip`
  - rw-3 top5: `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/compress/index.ts`, `src/middleware/serve-static/index.ts`
- **英6** rw-2 hit5=1 top1=1 → rw-3 hit5=1 top1=1。无变化
  - rw-3 改写:`validate request body with a validator`
  - rw-3 top5: `src/validator/validator.ts`, `src/validator/validator.ts`, `src/request.ts`, `src/request.ts`, `src/request.ts`
- **S1** rw-2 hit5=0 top1=0 → rw-3 hit5=1 top1=1。改写含 routing/router/matcher 等类别词形态,判定文件进入首位(S1 记为已知问题,本轮命中不代表已稳定)。
  - rw-3 改写:`routing route routes router Router match matching path matcher`
  - rw-3 top5: `src/router/reg-exp-router/matcher.ts`, `src/router.ts`, `src/router/pattern-router/router.ts`, `src/router.ts`, `src/helper/route/index.ts`
