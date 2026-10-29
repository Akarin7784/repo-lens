# RAG 调参题(12 题)

T-214 调参用的题目,来自 embedding 基准(hono @ `ed1d5f72135ccf7e09c17d64dc4af7588dd3e491`)。这里只放题目和大致应命中的位置,不放任何检索或调参结果。放在这里是为了和 [`RAG_HOLDOUT.md`](./RAG_HOLDOUT.md)(留出集)对照,确认两组题不重叠。

| # | 题目 | 应命中(参考) |
|---|---|---|
| 中1 | 如何设置 CORS 跨域中间件 | `src/middleware/cors/index.ts` 的 `cors` |
| 中2 | 怎么从请求里读取 JSON 请求体 | `src/request.ts` 的 `HonoRequest.json` |
| 中3 | 路由参数是怎么解析的 | `src/request.ts` 的 `param`;`src/router/*` |
| 中4 | 如何返回流式响应 | `src/helper/streaming/*` 的 `stream` / `streamText` |
| 中5 | JWT 鉴权中间件怎么验证 token | `src/middleware/jwt/jwt.ts` 的 `jwt` |
| 中6 | 如何设置和读取 cookie | `src/helper/cookie/index.ts` 的 `setCookie` / `getCookie` |
| 英1 | how to set up basic auth middleware | `src/middleware/basic-auth/index.ts` 的 `basicAuth` |
| 英2 | where are route parameters matched in the router | `src/router/*` 的 `match` |
| 英3 | how to serve static files | `src/middleware/serve-static/*` |
| 英4 | how does the app handle errors and not found | `src/hono-base.ts` 的 `errorHandler` / `notFoundHandler` |
| 英5 | compress response with gzip | `src/middleware/compress/index.ts` 的 `compress` |
| 英6 | validate request body with a validator | `src/validator/validator.ts` 的 `validator` |

## 待修 bug 记录(2026-10-29 架构师裁定)

- S1「路由匹配在哪个文件?」(原为演示冒烟题)并入调参集,作为待修 bug 记录;诊断见 [`RAG_EVAL_T214.md`](./RAG_EVAL_T214.md)「S1 诊断」。修复另开 PR,用新题复验。
