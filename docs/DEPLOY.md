# repo-lens 演示机部署方案(DEPLOY)

> **草案,标「未验证」「待实测」的都不是结论。** 基于 main `6c0367c`;代码核对在 `1381ce8` 上做,`1381ce8..6c0367c` 未改本文引用的文件(只改了评测脚本、rag 评测、worker 测试与文档)。本文只出方案,不改代码;落地代码另开小 PR。

## 0. 待 Eva 确认的前置项(集中)
| # | 问题 | 现状 / 默认 |
|---|---|---|
| E1 | 域名 | **Eva 已决定暂不做,用 IP 访问**(以后有域名再加) |
| E2 | HTTPS 证书 | **Eva 已决定暂不做**,演示走 HTTP+IP(风险见 §2.2) |
| E3 | 备案 | 不用域名,**不再是前置项**(以后启用域名时再查,当前未验证) |
| E4 | 演示是否对外公开(公开网址 vs 只在面试现场用) | 决定 §6 的防护缺口是否必须先补 |
| E5 | 快照保留策略 D5 | 沿用架构师临时默认:每仓库最近 10 个提交、LRU(`SNAPSHOT_KEEP_PER_REPO`);**清理逻辑未实现**;**待 Eva 确认** |
| E6 | 备份存放位置(本机另一目录 / 对象存储 / 下载到本地) | 待定 |
| E7 | GHCR 推送/拉取所需凭据(仓库已裁定为 GHCR) | 香港拉取速度未验证 |

## 1. 仓库现状(读自 main)
- `docker-compose.yml`:web(3000)、api(4000)、worker、mysql:8.4、redis:7-alpine(AOF)、qdrant v1.12.4;卷 `repos/mysql/qdrant`。当前 web/api 端口直接映射到宿主机,mysql/redis/qdrant 映射到 127.0.0.1;无日志限制;redis 无密码;只有 worker 有 mem/cpu 上限。
- 数据库:部署用 **MySQL 8.4**(与 ARCHITECTURE 一致)。MariaDB 仅是面试助手本地测试环境,compose 不写 MariaDB。
- 迁移:`packages/db/migrations/0000–0003`,由 **api 启动时执行**(GET_LOCK 互斥),worker 用 waitForSchema 等待。CI `smoke` 作业用仓库 compose 起 `mysql:8.4` 并跑通 api 启动与分析链路(`scripts/ci-smoke.sh`),所以 0000–0003 在 CI 的 MySQL 8.4 **空库**上执行过;已有数据的库上升级未验证。演示机仍要跑一遍(见清单)。
- Dockerfile:api/web 为 node:20-alpine;worker 为 node:20-bookworm-slim,构建时默认下载 e5 本地模型(约 490 MB)。dashscope 下能否跳过本地模型的代码核对(`apps/worker/src/index.ts` 42–51 行):`EMBEDDER=onnx` 时启动即构造 `OnnxEmbedder`(是否在构造时就读 `/models` 未核对);有 `DASHSCOPE_API_KEY` 时实际用 DashscopeEmbedder;**无 key 时退回 baseEmbedder**(onnx 或 fake),与「缺 key 记 skipped」的约定是否一致需在 PR 里复核。结论:现状不能保证 dashscope 下完全不读 `/models`,所以演示镜像先按默认下载 e5。
- web:`compress: false`(为 SSE 关压缩),`/api/*` 由 Next rewrites 在构建期固定到 `http://api:4000`;字体随仓库打包(#68)。
- api:`trustProxy: true`,限流按 `req.ip`;SSE 心跳 `pingIntervalMs` 默认 15 s。
- worker:`WORKER_CONCURRENCY` 默认 2。

## 2. compose 部署方案
以下 compose 与 Caddyfile 只是文档片段,不入 `deploy/` 目录;不改开发用 `docker-compose.yml`。

```yaml
x-log: &log { driver: json-file, options: { max-size: "10m", max-file: "3" } }
services:
  caddy:            # 唯一对外入口
    image: caddy:2
    ports: ["80:80"]          # 443 暂不做,以后有域名再加
    volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy_data:/data]   # 不申请证书;保留卷供以后启用 HTTPS
    depends_on: { web: { condition: service_started } }
    mem_limit: 128m
    restart: unless-stopped
    logging: *log
  web:
    image: ${IMAGE_REPO}/web:${TAG}
    mem_limit: 512m        # 无 ports
    restart: unless-stopped
    logging: *log
  api:
    image: ${IMAGE_REPO}/api:${TAG}
    env_file: /etc/repo-lens/app.env
    environment: { REPOS_DIR: /data/repos }
    volumes: ["repos:/data/repos:ro"]   # 代码核对:files.ts 只以 O_RDONLY|O_NOFOLLOW 打开,api 无写快照的代码,只读可行(容器内未实测)
    # 已裁定:api 启动时跑迁移(GET_LOCK 互斥)
    depends_on:
      mysql: { condition: service_healthy }
      redis: { condition: service_healthy }
      qdrant: { condition: service_healthy }
    healthcheck: { test: ["CMD","wget","-qO-","http://localhost:4000/health"], interval: 10s, retries: 3 }
    mem_limit: 768m
    restart: unless-stopped
    logging: *log
  worker:
    image: ${IMAGE_REPO}/worker:${TAG}
    env_file: /etc/repo-lens/app.env
    environment: { REPOS_DIR: /data/repos, WORKER_CPUS: "2" }
    volumes: [repos:/data/repos]
    read_only: true        # 未验证:git(clone.ts 设 HOME=/nonexistent,临时目录在 REPOS_DIR 内)与 Tree-sitter 是否需可写 HOME/缓存,演示机先试跑,不行就去掉
    tmpfs: [/tmp]
    cpus: 2
    mem_limit: 1536m       # dashscope 下不调用本地模型(估算);若回退 local 需 3g
    security_opt: ["no-new-privileges:true"]
    deploy: { replicas: 1 }  # 必须单实例,见 §7
    depends_on: { api: { condition: service_healthy }, redis: { condition: service_healthy }, qdrant: { condition: service_healthy } }  # waitForSchema 兜底
    restart: unless-stopped
    logging: *log
  mysql:
    image: mysql:8.4
    env_file: /etc/repo-lens/mysql.env   # MYSQL_ROOT_PASSWORD
    environment: [MYSQL_DATABASE=repolens]
    command: ["--innodb-buffer-pool-size=512M", "--binlog-expire-logs-seconds=259200"]
    volumes: [mysql:/var/lib/mysql]
    healthcheck: { test: ["CMD-SHELL","mysqladmin ping -h 127.0.0.1 -uroot -p\"$$MYSQL_ROOT_PASSWORD\" --silent"], interval: 5s, retries: 30, start_period: 20s }
    mem_limit: 1280m       # 无 ports
    restart: unless-stopped
    logging: *log
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction"]
    # 密码暂缓:Redis 只在内部网络、不映射端口;带密码 REDIS_URL 的读取方式未验证
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, retries: 20 }
    mem_limit: 384m
    restart: unless-stopped
    logging: *log
  qdrant:
    image: qdrant/qdrant:v1.12.4
    env_file: /etc/repo-lens/qdrant.env  # QDRANT__SERVICE__API_KEY
    volumes: [qdrant:/qdrant/storage]
    healthcheck: { test: ["CMD-SHELL","bash -c '</dev/tcp/127.0.0.1/6333'"], interval: 10s, retries: 10 }  # 未验证:qdrant 镜像里不一定有 bash,须在镜像里实测;不行就改 service_started + api 侧重试
    mem_limit: 768m
    restart: unless-stopped
    logging: *log
volumes: { repos: {}, mysql: {}, qdrant: {}, caddy_data: {} }
```
- 网络:默认 compose 网络即内部网络;**只有 caddy 映射端口**,MySQL/Redis/Qdrant/api/web 都不映射。云安全组只放行 22(限来源 IP)、80。
- 启动顺序(已裁定):mysql/redis/qdrant 健康 → api(启动时迁移,GET_LOCK 互斥)健康 → worker(waitForSchema 兜底)→ web → caddy。迁移失败则 api 不健康,worker 不启动。
- 重启策略:全部 `unless-stopped`。
- 独立迁移入口:可选后续优化,不阻塞演示。Redis 密码暂缓(同上)。密钥一律走 env_file,compose 里 `${...}` 只用于镜像名/标签。

### 2.1 内存预算(估算,未验证)
| 服务 | mem_limit |
|---|---|
| mysql | 1280m |
| qdrant | 768m |
| api | 768m |
| worker | 1536m |
| web | 512m |
| redis | 384m |
| caddy | 128m |
| 合计 | ≈5.3 GB,给系统与 Docker 留约 2.7 GB(≥1 GB 要求) |

数值全部是估算;部署后用 `docker stats` 在分析 hono 时看峰值再调。swap(已裁定):开 2 GB swapfile 并调低 `vm.swappiness=10`,防 OOM 直接杀进程,代价是被换出时变慢;效果未验证。
`WORKER_CONCURRENCY`(已裁定):演示机取 1——预分析仓库提前跑好,并发 2 分析大仓库有 OOM 风险。若回退本地 e5(EMBEDDING_PROVIDER=local),worker 需 3g,总和需重算。

### 2.2 反向代理(HTTP+IP)
- **Caddy** 只监听 80,HTTP,不申请证书(Eva 已决定暂不做域名/HTTPS)。备选 Nginx。HTTPS 与 443:暂不做,以后有域名再加。
- 路由:`/api/*` 直接转 `api:4000`(绕过 Next rewrites,少一层缓冲),其余转 `web:3000`。
- SSE(进度 SSE 与 `/api/repos/:id/chat`):关缓冲(Caddy `flush_interval -1`;Nginx `proxy_buffering off; proxy_read_timeout 300s; gzip off` 于该 location),读超时放宽到 ≥300 s;服务端已有 15 s 心跳。**部署后用 `http://<服务器IP>`实测逐字输出**(列入清单)。
- 压缩:next `compress:false`,Caddy 对非 SSE 路径开 `encode gzip zstd`,对 SSE 路径不压缩。15M 上行下大图首屏耗时**未验证**,要在香港机实测。
```
# 全局 auto_https off + 站点地址 :80(不写 http://:80,也不写 IP 站点地址——后者可能触发证书申请)
{
  auto_https off
}
:80 {
  @nosse not path /api/jobs/*/events /api/repos/*/chat
  encode @nosse gzip zstd          # 只压缩非 SSE 路径
  handle /api/* {
    reverse_proxy api:4000 {
      flush_interval -1
      # 未验证:Caddy 默认丢弃不受信客户端的 XFF 并重写,下一行可能多余,留着不影响;以第 61 次返回 429 的实测为准
      header_up X-Forwarded-For {remote_host}
    }
  }
  handle {
    reverse_proxy web:3000
  }
}
```
- 路由核对(main 1381ce8,`apps/api/src/app.ts`):进度 SSE 为 `GET /api/jobs/:id/events`(第 200 行,已确认)。问答路由 `/api/repos/:id/chat` 在 main 上**尚不存在**(P4 未接),路径按 ARCHITECTURE/P4 设计写,P4 合并后再核对。
- `/api/*` 整体 `flush_interval -1`;X-Forwarded-For 由 Caddy 覆盖为真实客户端 IP(配合 api `trustProxy:true`;Caddy 指令写法与覆盖效果未验证,清单实测伪造)。
- 不申请证书的依据:按架构师裁定写成全局 `auto_https off` + 站点地址 `:80`:Caddy 文档的一般说法是只写端口、无主机名的站点不启用自动 HTTPS,`auto_https off` 关闭自动 HTTPS 与跳转;不用 IP 作站点地址(可能触发证书申请)(依据为 Caddy 官方文档的一般说法,本次未逐字核对版本差异,**未验证**;部署后看 Caddy 启动日志无证书申请、`ss -tlnp` 无 443 为准)。
- 风险(HTTP+IP):
  - 明文传输:问题、代码片段、响应都可被链路上嗅探;不要在演示中输入任何敏感内容。
  - 浏览器对非 HTTPS(非安全上下文)的限制:剪贴板 API(如「复制」按钮)、Service Worker 等可能不可用,地址栏显示「不安全」;具体影响**未验证**,清单里实测。
  - 非安全上下文下 `crypto.randomUUID`、`navigator.clipboard`、`crypto.subtle`、Service Worker、`getUserMedia` 等不可用。
  - 前端待查:main 1381ce8 上对 `apps/web` 与 `packages/shared` 只读 `git grep` 了 `randomUUID|clipboard|crypto.subtle|serviceWorker|getUserMedia|isSecureContext|navigator.share`,**无命中**(依赖库内部用法未查)。仍请前端在后续 PR 中留意,新增这类用法须换成不依赖安全上下文的写法或加降级。
  - 对外公开时 IP 易被扫描;限流、预算上限照旧生效。
- 二维码:**等服务器 IP 确定后再生成**;用任意二维码工具对 `http://<服务器IP>` 生成,放进演示脚本;本文只放占位符,不写真实 IP。本地生成示例:
  - `qrencode -o demo-qr.png -s 10 'http://<服务器IP>'`
  - `python3 -c "import qrcode; qrcode.make('http://<服务器IP>').save('demo-qr.png')"`(需 `pip install qrcode[pil]`)

### 2.3 镜像发布与回滚
- 已裁定:CI 构建 api/web/worker 镜像,按提交 hash 打标签推 **GHCR**,服务器只 `docker compose pull && up -d`。香港拉取 GHCR 速度未验证。
- worker 镜像:**在「worker 在 dashscope 下不读 /models」PR 合并前,按默认 `EMBEDDING_MODEL_DOWNLOAD=1` 下载 e5 构建**,镜像多约 490 MB(数字来源:`apps/worker/Dockerfile` 注释「5 个文件约 490 MB」,未独立测量)。
- 回滚:`/etc/repo-lens/release.env` 里 `TAG=<上一个 hash>`,`up -d`。迁移只增列;回滚到迁移前版本前先确认 schema 兼容(ARCHITECTURE §6:api 与 worker 必须同版本一起升级)。
- 拉取太慢时退回服务器上 `docker compose build`,**构建时停 worker**;4C8G 上构建耗时与内存峰值未验证。

## 3. 日志与磁盘
- 日志:所有服务 `json-file`,`max-size: 10m`、`max-file: 3`(每容器 ≤30 MB,8 个约 240 MB)。同时在 `/etc/docker/daemon.json` 设相同默认值。
- 60 GB 分配(估算):系统+Docker 运行时 10 GB;镜像 6 GB(保留当前与上一标签);构建缓存 ≤5 GB(服务器构建时);MySQL 5 GB;Qdrant 5 GB;repos 快照 10 GB;备份 8 GB;余量 ≥10 GB。
- 增长来源:repos 快照(**清理未实现,只增不减**);Qdrant 每换 provider/模型/维度就新建集合,旧集合保留;MySQL binlog(设 3 天过期);备份。
- 定时清理(cron,每日 04:00 香港时间):
  - 只清悬空镜像:`docker image prune -f`(不加 -a);保留当前与上一个 TAG,更旧标签手动 `docker rmi`;`docker builder prune -af --filter "until=72h"`;**不自动 prune 卷**。
  - 快照清理实现前:手动脚本按 D5 默认(每仓库最近 10 个提交,LRU)删 `repos` 卷内旧 `{repoId}/{commitSha}`,只在 worker 空闲时跑;预分析仓库(hono/zustand/zod/trpc)的当前提交加白名单。
  - 删除无用 Qdrant 集合手动执行,不自动。
- 告警阈值:根分区使用 ≥75% 告警、≥85% 停止接收新分析(手动关闭提交或下调限流)、≥90% 立即清理。告警方式(邮件 / 机器人)待定。命令:`df -h /; docker system df; docker run --rm -v repo-lens_repos:/r alpine du -sh /r`。

## 4. 外部服务与密钥
- 默认 `EMBEDDING_PROVIDER=dashscope`,不放本地模型;`LLM_PROVIDER=deepseek`。
- embedding 模型:代码默认已是 qwen3.7-text-embedding,见 docs/EMBEDDING_TUNING.md;`DASHSCOPE_EMBEDDING_MODEL` 留空即用默认。
- 密钥只放服务器 `/etc/repo-lens/*.env`,`root:root`、`chmod 600`;不写进 compose、不入库(仓库 `.gitignore` / `.dockerignore` 已含 `.env`);日志不含密钥。检查命令(只看有无泄漏,不打印值):
  ```
  stat -c '%a %U %n' /etc/repo-lens/*.env          # 期望 600 root
  # 用 bash 执行;printf 是 bash 内置,密钥不进进程列表;只输出变量名和文件名,不回显匹配行
  for v in DASHSCOPE_API_KEY DEEPSEEK_API_KEY; do
    k=$(grep "^$v=" /etc/repo-lens/app.env | cut -d= -f2-)
    [ -n "$k" ] || { echo "$v 在 /etc/repo-lens/app.env 中为空,跳过会造成假通过"; exit 1; }   # 空模式文件什么都不匹配,会静默通过
    if docker compose logs --no-color 2>/dev/null | grep -qF -f <(printf %s "$k"); then echo "LEAK $v (docker compose logs)"; else echo "ok $v"; fi
  done; unset k
  ```
- 环境变量(默认值来自 `.env.example` / ARCHITECTURE §6.2):

| 变量 | 演示机取值 | 依据 |
|---|---|---|
| DATABASE_URL | mysql://root:<密码>@mysql:3306/repolens | .env.example |
| MYSQL_ROOT_PASSWORD | 随机强口令(mysql.env) | 默认 change-me 不可用 |
| REDIS_URL | redis://redis:6379 | 密码暂缓(只在内部网络,不映射端口;读取方式未验证) |
| LLM_PROVIDER | deepseek | 默认 fake |
| DEEPSEEK_API_KEY | 环境文件注入 | 必填 |
| DEEPSEEK_BASE_URL | https://api.deepseek.com | 默认 |
| LLM_CHAT_MODEL / LLM_SUMMARY_MODEL | deepseek-flash | 默认 |
| EMBEDDING_PROVIDER | dashscope | 默认 local |
| EMBEDDER | 保留(仅 local 读取,待确认) | .env.example |
| DASHSCOPE_API_KEY | 环境文件注入(北京地域) | 缺失则 skipped + keyword-only |
| DASHSCOPE_EMBEDDING_BASE_URL | 留空=北京 | intl 见 §5 待实测 |
| DASHSCOPE_EMBEDDING_MODEL / _DIM / _TPM | 留空用代码默认(qwen3.7-text-embedding / 1024 / 模型 TPM) | models.ts 能力表 |
| EMBEDDING_TASK_BUDGET_CENTS | 50 | 默认,无外部依据 |
| EMBEDDING_BATCH_SIZE | 16(dashscope 实际 min(值,10,文档上限)) | .env.example / #89 |
| EMBEDDING_LOCK_TTL_SEC / _MAX_WAIT_SEC | 留空(300 / 3600) | lock.ts |
| LLM_TASK_BUDGET_CENTS / DAILY_LLM_BUDGET_CENTS | 30 / 500 | 默认,演示可下调 |
| RATE_LIMIT_NEW_REPOS_PER_HOUR / _SUBMITS_PER_HOUR | 5 / 60 | 默认;预分析时临时 ≥50 |
| MAX_REPO_MB / MAX_FILES | 300 / 5000 | 默认 |
| WORKER_CONCURRENCY / WORKER_CPUS | 1(已裁定)/ 2 | 默认 2/2;4 核建议 2~3 |
| QDRANT_URL / QDRANT_API_KEY / QDRANT_COLLECTION | http://qdrant:6333 / 随机 / code_chunks | 默认 |
| GITHUB_TOKEN | 细粒度令牌,只读、仅公开仓库(Public repositories read-only),不授予任何写权限(可选) | 提高 API 限额 |
| CLONE_TIMEOUT_MS / PARSE_* | 默认 | worker config.ts |
| NEXT_PUBLIC_AGG_EDGE_OPACITY | 0.3(构建期) | 默认 |

## 5. 延迟与降级(价格与延迟均未验证)
- 香港机访问北京站百炼接口有跨境链路,延迟**未验证**。
- 查询路径:query 向量化 5 s 超时、重试 1 次;Retry-After > 2 s 直接失败;失败或 provider/模型/维度不匹配 → 只用关键词检索(`done.retrieval='keyword-only'`,P4 接路由后才会真正设置)。最坏约 11 s(Retry-After ≤ 2 s 时 ≤ 12 s)。
- 索引路径:15 s 超时、3 次重试,Retry-After 封顶 10 s。
- 是否改用 `dashscope-intl.aliyuncs.com`:仅作待实测选项,不下结论(intl 需对应地域 key,是否可用未验证)。
- 待实测(在演示机上执行,结果只写进演示脚本):
```
for h in dashscope.aliyuncs.com dashscope-intl.aliyuncs.com api.deepseek.com github.com; do
  curl -o /dev/null -s -w "$h connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer}\n" https://$h/; done
mtr -rwc 20 dashscope.aliyuncs.com
time git clone --depth 1 https://github.com/honojs/hono /tmp/h && rm -rf /tmp/h
curl -so /dev/null -w "size=%{size_download} t=%{time_total}\n" -H 'Accept-Encoding: gzip' http://<服务器IP>/api/repos/<id>/graph   # 在演示电脑上测,带宽对图 JSON 的影响
```
- 首字延迟:面试前一天对每道演示问题各跑一遍,记录香港→百炼/DeepSeek 首字延迟、是否出现 keyword-only。

## 6. 公开网址防护:现状与缺口
| 项 | 现状 |
|---|---|
| 按 IP 限流 | 已实现:新仓库 5/小时、提交 60/小时(Redis,`trustProxy:true`)。**缺口**:trustProxy 全信任,需确认 Caddy 覆盖 X-Forwarded-For 而非追加(否则可伪造);问答接口限流未实现(P4 待做) |
| 任务并发上限 | 部分:`WORKER_CONCURRENCY`;无全局排队长度上限(缺口) |
| DeepSeek 每日硬上限 | 已有 `DAILY_LLM_BUDGET_CENTS`(全站 UTC 自然日),超限关闭新分析、问答降级 |
| 百炼每日硬上限 | **缺口**:只有单任务 `EMBEDDING_TASK_BUDGET_CENTS`,查询路径不受任务预算约束,无全站每日上限 |
| 超限友好提示 | 后端有错误码;前端提示文案是否覆盖两种超限未验证 |
| 只允许公开仓库 | 已实现:URL 白名单 + GitHub API `private:true` 拒绝(拿不到 private 时为 null,放行,缺口需确认) |

## 7. 单进程与已知限制
- DashScope TPM 令牌桶只在进程内,**worker 只能单实例**(多实例各自计数,靠 429 退避兜底)。
- embed-lock:同 commit 向量化 Redis 锁,TTL 300 s,最长等 3600 s,超时 embeddingStatus=failed;`embed-lock.int.test` 固定 sleep 偶发不稳(测试问题,非部署问题)。
- BM25 在进程内按 repo+commit 读切块,api 重启后首问较慢(未验证)。
- 预算用尽时已成功的批可能已写入 Qdrant(状态 skipped,检索不用)。
- 快照清理未实现;`/files` 在快照缺失时 409。
- ARCHITECTURE §6.3 仍写 2C4G VPS,与本机不同,本文以 4C8G 为准。

## 8. 演示机检查清单
**部署前**
- [ ] E4–E7 已确认;安全组只开 22/80
- [ ] Docker、compose 版本;daemon.json 日志上限;2 GB swap 决定
- [ ] `/etc/repo-lens/*.env` 600,密钥检查命令通过
- [ ] 已知:mysql 健康检查 `mysqladmin -p"$$MYSQL_ROOT_PASSWORD"` 沿用仓库现有写法,口令会出现在容器内进程参数里(仅容器内可见,未改;可选后续改用 `MYSQL_PWD` 环境变量)
- [ ] §5 测量命令跑完并记录(待实测项)
- [ ] 镜像 TAG 已推送并可拉取
- [ ] 校验 Caddyfile 语法(**未实测**;本片段尚未用 caddy validate 验证过):`docker run --rm -v $PWD/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2 caddy validate --config /etc/caddy/Caddyfile`

**部署后冒烟**

- [ ] `curl -sI http://<服务器IP>/` 返回 200,不是 301 或 308 跳转(证明 `auto_https off` 生效、没被强制跳到 443)。
- [ ] 在演示机上跑一遍迁移(空库 0000–0003),api/worker 健康
- [ ] `docker compose ps` 全 healthy;`ss -tlnp` 只见 80/22;Caddy 日志无证书申请;云安全组入站只有 22(限来源 IP)与 80
- [ ] 提交 zustand,用 `http://<服务器IP>` 实测进度流(`/api/jobs/:id/events`)逐条到达,不是结束时一次性到达:`curl -N http://<服务器IP>/api/jobs/<id>/events`
- [ ] P4 合并后:对着真实聊天路由再核对一遍 Caddy 配置(路径匹配、flush、不压缩),再实测问答流逐字输出
- [ ] 伪造 X-Forwarded-For 实测(用「提交」限流,不建任何任务)。**必须从演示机外面的电脑发,不要在服务器本机发**:本机请求在 Caddy 眼里是 Docker 网桥地址,清理限流键会找错。
  - 代码口径(main 1381ce8,`apps/api/src/app.ts` 92–160、`packages/db/src/redis-keys.ts`):
    - 提交限流 `rl:sub:<ip>:<小时桶>`,阈值 `RATE_LIMIT_SUBMITS_PER_HOUR`(默认 60),在解析请求体**之前**计数,所有 `POST /api/repos` 都算(含 400、复用、出错);第 61 次起 429 `RATE_LIMITED`。
    - 新任务限流 `rl:ip:<ip>:<小时桶>`,阈值 `RATE_LIMIT_NEW_REPOS_PER_HOUR`(默认 5),只计真正入队的新任务或 failed 重试;同仓库同 commit 已有未失败任务时复用、不计数,所以对同一仓库重复提交不会触发它。
    - 两个键都按自然小时分桶,TTL 3600 s;`req.ip` 来自 `trustProxy:true`。
  - 命令:发空请求体,每次伪造不同 XFF,只会得到 400 `BAD_REQUEST`,不建仓库、不建任务:
    `for i in $(seq 1 61); do curl -s -o /dev/null -w '%{http_code} ' -XPOST http://<服务器IP>/api/repos -H 'content-type: application/json' -H "X-Forwarded-For: 10.9.8.$i" -d '{}'; done; echo`
  - 预期:Caddy 覆盖 XFF 时全部按真实 IP 计数,前 60 次 400,**第 61 次 429**;若 61 次全是 400,说明伪造 XFF 生效(计数被分散到伪造 IP),trustProxy/代理配置有缺口。Caddy 是否覆盖而非追加 XFF、Fastify 取哪一段为 `req.ip`:**未验证**,以本实测为准。
  - 测前确认本小时该 IP 未提交过(否则 429 会提前出现);测完删掉 `rl:sub:<真实IP>:*`(`docker compose exec redis redis-cli --scan --pattern 'rl:sub:*'` 找到后 `DEL`)或等到下一个小时桶,再做预分析等提交操作。不用 hono/zustand/zod/trpc 或任何真实仓库地址。
- [ ] 真实触发一次花费硬上限(临时把 DAILY_LLM_BUDGET_CENTS / EMBEDDING_TASK_BUDGET_CENTS 设 0)看友好提示;真实触发一次 keyword-only(临时错误 DASHSCOPE key 或不可达)看降级提示;不能只靠单元测试;测完还原
- [ ] 断外网(iptables 临时拦出站,保留 SSH)打开页面:web 不依赖外部 CDN(字体/高亮/图标已打包,未验证)
- [ ] `docker stats` 在分析时看内存峰值
- [ ] 重启整机后服务自动恢复,预分析数据仍在

**预分析与备份**
- [ ] hono/zustand/zod/trpc 用 `scripts/demo-prep.sh` 预跑(临时调高限流),数据在命名卷
- [ ] MySQL:每日 `mysqldump --single-transaction` 压缩,保留 7 份;导出一份到 E6 位置
- [ ] Qdrant 视为可重建;可选 `POST /collections/<name>/snapshots` 导出;一键重建脚本方案:清空对应仓库 → demo-prep 重跑(只写方案)
- [ ] 录好演示兜底视频

**演示前 30 分钟**
- [ ] 用演示用的电脑和浏览器过一遍(中文字体取系统字体)
- [ ] 用演示设备与浏览器在 HTTP+IP 下过一遍:完整走一遍提交、出图、问答和高亮,确认不受非安全上下文限制(未验证,以实测为准)
- [ ] 用手机实际扫一次演示二维码,确认能打开 `http://<服务器IP>`
- [ ] 每道演示问题跑一遍,确认非 keyword-only;`df -h` < 75%
- [ ] 预算余额充足;限流恢复默认

**演示后**
- [ ] 导出 MySQL 备份;按 D5 决定处理快照
- [ ] 若不再公开,停止 caddy 或关 80
- [ ] 记录实测延迟与问题

**回滚**:改 TAG 为上一标签 → `docker compose pull && up -d`;数据坏则停服务、恢复最近 mysqldump、Qdrant 重建。
**重启后恢复**:`unless-stopped` + Docker 开机自启;检查 `docker compose ps`、迁移已完成、预分析仓库可打开。

## 9. 后续代码 PR(顺序以架构师 9:23 口径为准)
1. 评测脚本 provider/model 选择、测试补强两个小 PR(进行中)
2. P4 问答路由(含问答限流、客户端断开中止)
3. worker 在 `EMBEDDING_PROVIDER=dashscope` 时完全不读 `/models`:不构造 OnnxEmbedder、缺 key 不退回本地/假向量。测试证明:把 `EMBEDDING_MODEL_DIR` 指向不存在目录、`EMBEDDER=onnx`、provider=dashscope 启动 worker 装配函数,断言不抛错且 OnnxEmbedder 构造计数为 0(spy);再用 `EMBEDDING_MODEL_DOWNLOAD=0` 构建的镜像在 CI smoke 里以 dashscope+假 key 起 worker 不崩。合并后才能改 `EMBEDDING_MODEL_DOWNLOAD=0`。
4. 百炼全站每日花费上限
5. 全局排队长度上限
6. GitHub `private` 为 null 时的处理
- 可选(不阻塞演示):独立迁移入口;Redis 密码;快照 LRU 清理另排期。

## 10. 风险
- worker `read_only`、Qdrant 健康检查命令(未验证,演示机试跑)。
- 跨境延迟高时是否换 intl 域名(待实测)。
