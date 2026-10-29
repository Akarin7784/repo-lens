# qwen3.7 embedding 选型:调优集结果

> 本节(规则)在开跑前写定,经面试助手确认后才跑;跑完不改本节。
> 状态:**规则已确认;A、B 各跑一次,已完成;结论选 A(差距在噪声范围内);冻结待做。不得写成「检索已验收」,须等 v3 通过。**

## 一、规则(架构师 + 面试助手,2026-10-29)
1. **变量只有模型,维度固定 1024。** 两个模型的设置:
   - A:`EMBEDDING_PROVIDER=dashscope DASHSCOPE_EMBEDDING_MODEL=qwen3.7-text-embedding DASHSCOPE_EMBEDDING_DIM=1024`
   - B:`EMBEDDING_PROVIDER=dashscope DASHSCOPE_EMBEDDING_MODEL=qwen3.7-text-embedding-flash DASHSCOPE_EMBEDDING_DIM=1024`
   - **两个模型先后串行运行,不能并发;固定顺序:A(qwen3.7-text-embedding)在前,B(qwen3.7-text-embedding-flash)在后。**
   - 运行前记录 `git -C $HONO_DIR rev-parse HEAD`(`HONO_DIR` 是 `scripts/rag-eval.mjs` 实际读取的变量,默认 `/tmp/hono`),必须是 `ed1d5f7`,否则不跑。
   - 其余环境变量完全一致:HONO_DIR、DEEPSEEK_API_KEY(真实改写)、不设 EMBEDDING_BATCH_SIZE / DASHSCOPE_EMBEDDING_TPM / DASHSCOPE_EMBEDDING_BASE_URL(都取默认)。两次都不加 `--fake-llm`。
2. **只用调优集(tuning)**,共 **12 题**(中1–中6、英1–英6,hono @ ed1d5f7,按文件判定)。v2/v3 不参与选型。
3. **选型规则**:
   - 前 5 命中数(top5)更高者胜;
   - top5 相同,看第 1 命中数(top1);
   - 两者都相同,选 flash;
   - 只差一题时,结论里必须写「差距在噪声范围内」。
4. **降级与重跑**:
   - 每个模型最多跑两次;比较只用降级题数为 0 的那次;
   - 降级题:每次运行后同时 grep `FAILED`(不带后缀,覆盖 `FAILED rewrite=…(未检索)` 和 `FAILED(降级`)和 `retrieval=keyword-only`,任一出现都按降级题计,按下一条口径处理;
   - 重跑的触发条件只能是限流(429 / Retry-After)或超时(5s),先查清原因再重跑;**不能因为分数不理想重跑**;
   - 重跑后仍有降级题时,**这一轮作废**:先修基础设施(限流配额、网络、超时),不再继续重跑;修好后整轮重来,并在本文记录作废原因。整轮重来的触发只限基础设施原因;新一轮 A 仍在前,两个模型各自最多两次运行,另起一节记录。
5. 选定后**最多再做一轮参数调优**,只针对选中的模型。
6. 每次运行都记:完整命令(不含 key)和 `EVAL embedding provider=… model=… dim=… collection=…` 开始行原文。
   - 开始行和 usage 行只打印到控制台,不会自动进结果文件,要从控制台原文抄进运行记录。
   - B 的验收:12 题全部 `rewrite=cached`,且逐题 `rw="…"` 与 A 的完全一致(A 里出现 `used` 是允许的,能发现缓存缺题)。
   - 改写缓存一致:A、B 两次运行时 `/tmp/rl-eval-rewrites.json` 的内容哈希必须相同。每次运行前后都用 `sha256sum` 记哈希;不同就停下,不比较。
   - 注意:A 运行时如果改写缓存缺题,会新写入,A 的「运行前」和「运行后」哈希就会不同。比较口径是 **A 运行后 = B 运行前 = B 运行后**。建议开跑前确认 12 题已全部在缓存里(A 运行前后哈希也相同),最稳。
7. 每个模型各记一次索引用的总 token 数、估算费用和降级题数,便于和百炼用量对账。
   - 单价(文档,北京):qwen3.7-text-embedding 0.0005 元/千 token,flash 0.000125 元/千 token。
   - 估算费用 = 总 token ÷ 1000 × 单价。
   - token 数取自 `EVAL embedding usage` 行(#96 的实际格式):
     - 实测:`EVAL embedding usage reused=0 totalTokens=<响应 usage.total_tokens 累计> batches=<批数>`;
     - 有批次没给 usage:同一行追加 `estimatedTokens=<估算>(估算,未计入totalTokens) estimatedBatches=<k>`。估算另列,不混入实测;
     - 复用向量缓存:`EVAL embedding usage reused=1 totalTokens=未测`,不是 0。
   - `totalTokens` 只统计成功返回的批次;超时重试的失败请求可能也计费,所以它是**下限**,对账时要写明。
   - 重跑会复用向量缓存,索引不再计 token(该行为 `reused=1 totalTokens=未测`),所以 token 只记第一次运行。
8. **冻结记录**:写调优时的 main 提交哈希;面试助手之后核对 v3 在包含该提交的 main 上跑。
9. **不做冒烟,靠第一次正式运行判断降级**(面试助手规则):
   - 背景:调优轮曾因评测脚本没传 indexedProvider,dashscope 下每题都降级成 keyword-only;评测修复 PR 合并后才开跑。
   - 冒烟本来的记账口径(仅说明为什么不做):每个模型各冒烟一次会先建整个 hono 的向量索引并写缓存,之后正式运行 usage 行会变成 `reused=1 totalTokens=未测`,token 数只能取冒烟那次 usage 行原文并标「来自冒烟的索引」;冒烟会写入改写缓存,哈希要从 A 冒烟前开始记,口径「A 跑后 = B 跑前 = B 跑后」;冒烟不计入比较,也不占两次名额。
   - `scripts/rag-eval.mjs` 调优集分支没有只跑一题的现成方式(只读集合名、`--fake-llm`、`--force`),所以**不做冒烟、不为它改脚本**,不用 `--commit/--prefix/--rows/--id-letter/--holdout-file`。
   - 第一次正式运行的 12 题出现 `retrieval=keyword-only` 或 `FAILED` 即按第 4 条降级处理;索引已写向量缓存,重跑不重复花 token,token 数按第 7 条取第一次正式运行的 usage 行。
10. 中断的 A-run1 按架构师裁定处理:作废,不占 A 的两次名额,不算 A 第 1 次;见第四节「规则未定稿时被停止,作废」。

## 二、开跑前提
- **基于最新 main,含 #96 和评测修复 PR**:#92(provider 选择,已合并)、#96(usage 行)和评测修复 PR(传 indexedProvider)都要在这个 main 上;冻结记录写这个 main 的提交哈希。两者任一没合并前不能跑。
- 向量缓存:两个模型的集合名不同(`eval_dashscope_qwen3_7-text-embedding_1024` 和 `eval_dashscope_qwen3_7-text-embedding-flash_1024`),缓存文件分开,互不复用。
- 改写缓存 /tmp/rl-eval-rewrites.json 两个模型共用(key 与 embedding 无关),两边改写结果相同,符合「变量只有模型」。

## 三、冻结记录(跑时填)
- main 提交(须包含 #96 且含评测修复 PR):`786024a00cda9b57c3a1c2832a53c2872935bbb2`(含 #100 `964557c`、#99;hono `ed1d5f72135ccf7e09c17d64dc4af7588dd3e491`)
- 运行时间(UTC+8):2026-10-29,构建完成 22:05:39;A 22:05:43–22:08:37;B 22:08:46–22:11:15
- provider `dashscope`;模型 id `qwen3.7-text-embedding` / `qwen3.7-text-embedding-flash`;维度 1024;区域 北京(华北2,已核对,见下);文档单批上限 20 条(两个模型,搜索引用,未逐页打开),本次实际 10 条/批(代码取 min(EMBEDDING_BATCH_SIZE=16, DASHSCOPE_DEFAULT_BATCH_CAP=10, docBatchMax=20),1604 块 → 161 批);文档核对日期 2026-10-29
- 调优集命中:A top5 11/12、top1 11/12;B top5 11/12、top1 10/12
- 规则节 sha256:`e2c1a8d7bc4e085ec54172c2b9080ff3d3dcd62f2601b4c6016cb103970b0920`,算法 `sed -n 6,45p qwen37-tuning-result.md | sha256sum`(第 6 行「## 一、规则」到第 45 行)。不用 `head -45`,因为第 1–5 行文档头的状态行按要求改过。
- 文档整体 sha256:另见报告,以本次修改后的文件为准(写进本文件会改变自身 hash,所以不写在这里)。
- 官方文档核对(2026-10-29,阿里云帮助中心;以下摘录为**搜索引用**,未逐页打开核对):
  - 出处 1:https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api(镜像 https://docs.bailian.console.aliyun.com/zh/model-studio/text-embedding-synchronous-api)。「北京」表摘录:「qwen3.7-text-embedding | … | 20 | 128,000 | 0.0005元 Batch调用:0.00025元」「qwen3.7-text-embedding-flash | 1,024(默认)、768、512、256 | 20 | 128,000 | 0.000125元 Batch调用:0.000063元」;input 说明摘录:「qwen3.7-text-embedding 模型:… 输入为字符串列表或文件:最多支持 20 条(行)」。
  - 出处 2:https://help.aliyun.com/zh/model-studio/embedding。「北京」表「批次大小」两个模型均为 20;单价同上。
  - 出处 3:https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai。摘录:「华北 2(北京)地域:从 `https://dashscope.aliyuncs.com` 迁移至 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`」「现有域名仍可正常使用」;base_url 为 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。
  - 结论:单价已核对,与记录用的一致(A 0.0005、B 0.000125 元/千 token,北京)。批上限:文档两个模型都是 20(搜索引用),**与之前写的「10」不符**。10 是代码里的默认上限(`DASHSCOPE_DEFAULT_BATCH_CAP`),不是文档值,所以本次实际 10 条/批是代码保守取值,不违反文档。flash 文档矛盾:代码注释(`packages/rag/src/models.ts`)记录 flash「[实测] 21 条也返回 200(与文档不一致),仍按文档取 20」;文档本身两处都写 20,未发现文档内部矛盾,21 条之说只是实测,不是文档。域名:代码默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`(旧域名,文档说仍可用),白名单也允许 `<空间>.<地域>.maas.aliyuncs.com`;本次运行实际用的哪个 base_url 没有核对日志(未打印),**未验证**。

## 四、运行记录(跑时填,每次一节)
### 规则未定稿时被停止,作废
- 架构师裁定:作废,不计入比较,不占 A 的两次名额,不算 A 第 1 次。
- 命令:`HONO_DIR=/tmp/hono EMBEDDING_PROVIDER=dashscope DASHSCOPE_EMBEDDING_MODEL=qwen3.7-text-embedding DASHSCOPE_EMBEDDING_DIM=1024 node scripts/rag-eval.mjs tuning`(main `4c8a2b6`,hono `ed1d5f7`)
- 开始行原文:`EVAL embedding provider=dashscope model=qwen3.7-text-embedding dim=1024 collection=eval_dashscope_qwen3_7-text-embedding_1024`
- 起止时间(UTC+8):2026-10-29 21:56:17 开始,约 21:56:34 被中断(约 17 秒,停在建索引阶段)。无 usage 行、无题目结果、未写向量缓存。
- 日志:`/workspace/backend-dev/notes/tuning-logs/A-run1.log`
- 对账说明:这约 17 秒内已发出的 DashScope 请求可能已计费,金额未知,不计入 totalTokens。
- 改写缓存:6 道中文题已缓存,6 道英文题不走改写;`/tmp/rl-eval-rewrites.json` 哈希 `c7695f99cf90f7dd12a3e6269c15cd356ba28a5910be43db9043171377e35d2d` 在中断前后相同。
- key 泄漏检查(`grep -qF -f <(printf %s "$k")`,`[ -n "$k" ]` 保护,DASHSCOPE_API_KEY、DEEPSEEK_API_KEY):未命中。
- 残留进程检查(`pgrep -af rag-eval`,2026-10-29 21:59 UTC+8):无残留 rag-eval 进程。

### A 第 1 次
- 命令:`HONO_DIR=/tmp/hono EMBEDDING_PROVIDER=dashscope DASHSCOPE_EMBEDDING_MODEL=qwen3.7-text-embedding DASHSCOPE_EMBEDDING_DIM=1024 node scripts/rag-eval.mjs tuning`
- 开始行:`EVAL embedding provider=dashscope model=qwen3.7-text-embedding dim=1024 collection=eval_dashscope_qwen3_7-text-embedding_1024`
- 改写缓存哈希:运行前 `sha256sum /tmp/rl-eval-rewrites.json` = `c7695f99cf90f7dd12a3e6269c15cd356ba28a5910be43db9043171377e35d2d`,运行后 = `c7695f99cf90f7dd12a3e6269c15cd356ba28a5910be43db9043171377e35d2d`
- usage 行:`EVAL embedding usage reused=0 totalTokens=218123 batches=161`
- total 行:`EVAL tuning total top5=11/12 top1=11/12 chunks=1604 llm=deepseek rewriteCalls=0 costMicroUsd=0 prompt=rw-3 chunker=2 embedText=1 revision=1024`(top5、top1 的分母都是 12)
- top5 = 11/12,top1 = 11/12,降级题数 0 / 总 token 218123(下限,源自 usage 行)/ 估算费用 ≈0.109 元(218123÷1000×0.0005 元)
- 运行前检查:hono HEAD `ed1d5f7`;`pgrep -af rag-eval` 无残留。中文 6 题 `rewrite=cached`,英文 6 题 `rewrite=not-chinese`,无 `used`。
- 日志:`/workspace/backend-dev/notes/tuning-logs/A-r1.log`;key 泄漏检查(两个 key):未命中
### B 第 1 次
- 命令:`HONO_DIR=/tmp/hono EMBEDDING_PROVIDER=dashscope DASHSCOPE_EMBEDDING_MODEL=qwen3.7-text-embedding-flash DASHSCOPE_EMBEDDING_DIM=1024 node scripts/rag-eval.mjs tuning`
- 改写缓存哈希(须与 A 相同):A 后 = B 前 = B 后 = `c7695f99cf90f7dd12a3e6269c15cd356ba28a5910be43db9043171377e35d2d`,相同
- B 验收:12 题全部 `rewrite=cached`,且逐题 `rw="…"` 与 A 的完全一致(A 里出现 `used` 是允许的,能发现缓存缺题)。
- (其余同上;top5、top1 分母 12)
- 验收结果:中文 6 题 `rewrite=cached`;英文 6 题 `rewrite=not-chinese`(非中文不走改写,与 A 一致,规则里「12 题全部 cached」对英文题不适用);12 题 `rw="…"` 逐题 diff 与 A 完全一致;哈希三者相同 → 通过。
- 注记(架构师确认,不改规则条文):英文题 `rewrite=not-chinese` 不算缺缓存。6 道英文题本来就不走改写,12 题 `rw` 内容与 A 完全一致。
- 开始行:`EVAL embedding provider=dashscope model=qwen3.7-text-embedding-flash dim=1024 collection=eval_dashscope_qwen3_7-text-embedding-flash_1024`
- usage 行:`EVAL embedding usage reused=0 totalTokens=218123 batches=161`
- total 行:`EVAL tuning total top5=11/12 top1=10/12 chunks=1604 llm=deepseek rewriteCalls=0 costMicroUsd=0 prompt=rw-3 chunker=2 embedText=1 revision=1024`
- top5 = 11/12,top1 = 10/12,降级题数 0 / 总 token 218123(下限)/ 估算费用 ≈0.027 元(218123÷1000×0.000125 元)
- 日志:`/workspace/backend-dev/notes/tuning-logs/B-r1.log`;key 泄漏检查:未命中;运行后无残留进程

## 五、结论(跑完填)
- top5 打平(11/12 vs 11/12);比 top1:A 11/12 > B 10/12(差的是 英4)。按规则选 **A `qwen3.7-text-embedding`**,但只差一题,**差距在噪声范围内**。
- 两边都错 英3(how to serve static files)。降级 0/0。
- 费用:按 usage totalTokens × 北京区域文档单价(A 0.0005 元/千 token,B 0.000125 元/千 token,2026-10-29 核对)估算,A ≈0.109 元,B ≈0.027 元;totalTokens 为下限。作废那次的费用未知,没算进去。
- 不再做参数调优:调优集已 11/12,唯一没中的 英3 两个模型都没中,再调容易过拟合。英3(静态文件)是已知弱点,演示脚本不要选这类题。
- 费用差异不影响选型(规则不看价格)。费用是估算,不含作废那次;totalTokens 是下限。
- 两个模型 totalTokens 完全相同(218123),说明两者用同一套计 token 方式;未核对文档,不下结论。
- 本节以外的改动:第 4 行文档头状态行改为实际状态(按要求);规则正文(第 6–45 行)未改。

## 六、入库说明
- 本文件由 box 上的 notes 复制入库;日志原文不入库(日志留在本地 `notes/tuning-logs/`),只保留规则要求逐字记录的命令、start 行、usage 行、total 行。
- 运行基线仍为 main `786024a`;入库 PR 开时的 main 也是 `786024a`。
- 本次运行实际使用的 base_url 未记录,**未验证**。
