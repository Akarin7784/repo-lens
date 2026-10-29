# RAG 验收题 holdout v3（中文）

> 注意:本表题号用 W1..W10(v2 为 V1..V10)。表格结构与 v2 相同(正好 10 行、每行 6 列、路径带反引号)。如果评测脚本只认 V 前缀,需由面试助手调整脚本,出题人不做猜测。

- 仓库:https://github.com/h3js/h3
- Commit:`f0e17808ac2439b6434bb10609a961067f4d555b`(所有路径和符号都已在这个 commit 核对)
- 许可证:MIT
- 出题日期:2026-10-29(Asia/Shanghai)
- 出题人:绿色三角形(没看过 repo-lens 的评测代码、调参集和以往结果)
- 范围:只认 `src/` 前缀;`test/` 下的同主题测试文件不算命中
- 命中判定:前缀加完整仓库相对路径精确匹配(文件级)。前 5 个检索切块里有任一参考文件就算命中,首位命中单独统计。符号只作参考,不计分。
- 通过线:前 5 命中至少 7/10,首位命中至少 4/10。
- 使用规则:只跑一次;跑之前任何人不得读本文件(运行脚本除外)。
- 冻结声明:出题后不得因为任何评测结果修改题目或参考文件。

| 编号 | 类型 | 问题 | 参考文件(任一命中即可) | 参考符号 | 理由 |
|---|---|---|---|---|---|
| W1 | 定位 | 读取和写入浏览器 Cookie 的工具函数在哪里? | `src/utils/cookie.ts` | `parseCookies`、`setCookie` | 解析请求 Cookie 头、设置和删除 Cookie 都在这里 |
| W2 | 定位 | 服务端向浏览器持续推送消息(SSE)是怎么实现的? | `src/utils/event-stream.ts`;`src/utils/internal/event-stream.ts` | `EventStream`、`formatEventStreamMessage` | 推送类与消息格式化、响应头设置 |
| W3 | 定位 | 用 HTTP 基本认证保护接口、校验用户名密码的逻辑在哪? | `src/utils/auth.ts`;`src/utils/internal/auth.ts` | `requireBasicAuth`、`timingSafeEqual` | 校验 Authorization 头并做常数时间比较 |
| W4 | 概念 | 会话数据是怎么加密后存进 Cookie,再在下次请求时解密校验的? | `src/utils/session.ts`;`src/utils/internal/iron-crypto.ts` | `sealSession`、`unsealSession`、`seal` | 会话封装调用 iron 风格的加密签名 |
| W5 | 概念 | 跨域请求时,浏览器先发的预检请求是怎么判断和应答的? | `src/utils/cors.ts`;`src/utils/internal/cors.ts` | `isPreflightRequest`、`handleCors` | 判断预检并追加允许来源、方法等响应头 |
| W6 | 概念 | 上传的请求体太大时,是在哪里限制大小并拒绝的? | `src/utils/body.ts` | `assertBodySize` | 边读边计数,超过上限抛 413 |
| W7 | 概念 | 提供静态文件时,怎么根据客户端支持的压缩格式挑选预压缩的文件? | `src/utils/static.ts` | `serveStatic`、`encodings` | 按 accept-encoding 解析偏好并映射到扩展名 |
| W8 | 流程 | 处理函数里抛出的异常,最后是怎么变成带状态码和 JSON 内容的 HTTP 响应的? | `src/response.ts`;`src/error.ts` | `toResponse`、`toError`、`HTTPError` | 把抛出值规范化为错误对象再生成错误响应 |
| W9 | 流程 | 把请求转发到另一个上游服务器时,哪些请求头和响应头会被丢掉或改写? | `src/utils/proxy.ts`;`src/utils/internal/proxy.ts` | `proxyRequest`、`ignoredHeaders`、`rewriteCookieProperty` | 转发逻辑与逐跳头过滤、Cookie 属性改写 |
| W10 | 流程 | 按路径模式统一配置重定向、缓存等规则时,请求进来是怎么找到适用规则并按顺序执行的? | `src/rules/match.ts`;`src/rules/compiler/compile.ts`;`src/rules/handlers/redirect.ts` | `createRouteRulesMatcher`、`compileRouteRules` | 规则路由匹配、合并并按 order 组装中间件 |
