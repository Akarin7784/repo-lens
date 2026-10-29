#!/usr/bin/env bash
# T-005 冒烟:真实构建镜像 → compose 起服务 → 轮询 /health → 镜像内 Node/原生绑定检查。
set -euo pipefail
TIMEOUT="${SMOKE_TIMEOUT:-120}"
[ -f .env ] || cp .env.example .env
# CI 不下载 embedding 模型(约 490 MB),worker 用确定性假向量
export EMBEDDING_MODEL_DOWNLOAD=0
sed -i 's/^EMBEDDER=.*/EMBEDDER=fake/' .env

# 失败时打印关键服务日志尾部,便于排错(成功时不打印;compose down 由 workflow 的 always 步骤负责)
on_fail() {
  echo "SMOKE: 失败,输出 api/worker/mysql 日志尾部"
  docker compose logs --no-color --tail=200 api worker mysql || true
}
trap 'rc=$?; [ $rc -ne 0 ] && on_fail; exit $rc' EXIT

t0=$(date +%s)
docker compose build api worker web
t1=$(date +%s)
echo "SMOKE build_seconds=$((t1 - t0))"

docker compose up -d
t2=$(date +%s)
body=""
until body=$(curl -fsS http://localhost:4000/health 2>/dev/null); do
  if [ $(( $(date +%s) - t2 )) -ge "$TIMEOUT" ]; then
    echo "SMOKE FAIL: api /health 在 ${TIMEOUT}s 内未就绪"; exit 1
  fi
  sleep 2
done
t3=$(date +%s)
echo "SMOKE ready_seconds=$((t3 - t2))"
echo "SMOKE health_body=$body"
echo "$body" | grep -q '"status":"ok"' || { echo "SMOKE FAIL: /health 返回不含 status ok"; exit 1; }

# T-211c:summary 迁移 0001 在真实 MySQL 8.4 上的幂等与回填检查。
# 用独立库 mig_check(不碰业务库);旧表结构直接取自 0000_init.sql(迁移前的 repo/summary 定义),
# 灌旧格式行(含 model='rule')后把 0001 连跑两遍,再断言列、唯一键与回填值。
# 口令只在容器内经 MYSQL_PWD 传给客户端,不出现在命令行与日志里
mysql_q() { docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4 -N -B "$@"' _ "$@"; }
mig_sql() { sed 's/--> statement-breakpoint//' "$1"; }
old_tables=$(awk '/^CREATE TABLE `(repo|summary)`/,/^\);/' packages/db/migrations/0000_init.sql)
SHA_OLD=0123456789abcdef0123456789abcdef01234567
mysql_q -e 'DROP DATABASE IF EXISTS mig_check; CREATE DATABASE mig_check'
{ echo "$old_tables"; echo 'CREATE INDEX `idx_input` ON `summary` (`input_hash`);'
  echo "INSERT INTO repo (id, url, last_commit) VALUES (1, 'https://github.com/o/a', '$SHA_OLD'), (2, 'https://github.com/o/b', NULL);"
  echo "INSERT INTO summary (repo_id, level, target_id, input_hash, model, content) VALUES
    (1, 'file', 'f:a.ts', REPEAT('a', 64), 'deepseek-chat', 'llm 摘要'),
    (1, 'file', 'f:b.ts', REPEAT('b', 64), 'rule', '规则摘要'),
    (1, 'dir', 'm:src', REPEAT('c', 64), 'deepseek-chat', '模块摘要'),
    (2, 'file', 'f:c.ts', REPEAT('d', 64), 'rule', '无 last_commit');"
} | mysql_q mig_check
for i in 1 2; do
  mig_sql packages/db/migrations/0001_summary_commit.sql | mysql_q mig_check \
    || { echo "SMOKE FAIL: 0001 第 $i 次执行失败"; exit 1; }
  echo "SMOKE migration_0001_run_$i=ok"
done
cols=$(mysql_q mig_check -e "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='mig_check' AND TABLE_NAME='summary' AND COLUMN_NAME IN ('commit_sha','source')")
idx=$(mysql_q mig_check -e "SELECT GROUP_CONCAT(DISTINCT INDEX_NAME ORDER BY INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='mig_check' AND TABLE_NAME='summary' AND INDEX_NAME LIKE 'uk_%'")
ukcols=$(mysql_q mig_check -e "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='mig_check' AND TABLE_NAME='summary' AND INDEX_NAME='uk_target_commit'")
rows=$(mysql_q mig_check -e "SELECT GROUP_CONCAT(CONCAT(target_id,'=',commit_sha,'/',source) ORDER BY target_id SEPARATOR ' ') FROM summary")
ver=$(mysql_q -e 'SELECT VERSION()')
echo "SMOKE migration_0001 mysql=$ver cols=$cols uk=$idx uk_cols=$ukcols"
echo "SMOKE migration_0001 rows=$rows"
[ "$cols" = "commit_sha,source" ] || { echo "SMOKE FAIL: 缺 commit_sha/source 列"; exit 1; }
[ "$idx" = "uk_target_commit" ] || { echo "SMOKE FAIL: 唯一键应只有 uk_target_commit(uk_target 应已删除)"; exit 1; }
[ "$ukcols" = "repo_id,level,target_id,commit_sha" ] || { echo "SMOKE FAIL: uk_target_commit 列不对"; exit 1; }
want="f:a.ts=$SHA_OLD/llm f:b.ts=$SHA_OLD/rule f:c.ts=/rule m:src=$SHA_OLD/llm"
[ "$rows" = "$want" ] || { echo "SMOKE FAIL: 回填不符,期望 $want"; exit 1; }
# 迁移 0002:摘要复用复合索引 idx_reuse,同样连跑两遍断言幂等与列顺序
for i in 1 2; do
  mig_sql packages/db/migrations/0002_summary_input_idx.sql | mysql_q mig_check \
    || { echo "SMOKE FAIL: 0002 第 $i 次执行失败"; exit 1; }
  echo "SMOKE migration_0002_run_$i=ok"
done
reuse=$(mysql_q mig_check -e "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='mig_check' AND TABLE_NAME='summary' AND INDEX_NAME='idx_reuse'")
echo "SMOKE migration_0002 idx_reuse=$reuse"
[ "$reuse" = "repo_id,level,target_id,input_hash" ] || { echo "SMOKE FAIL: idx_reuse 列不对或不存在"; exit 1; }
# EXPLAIN:摘要复用查询(findSummaryByInput 的 WHERE 形状)应走 idx_reuse
mysql_q mig_check -e "ANALYZE TABLE summary" >/dev/null
plan=$(mysql_q mig_check -e "EXPLAIN SELECT * FROM summary WHERE input_hash='$(printf 'a%.0s' $(seq 64))' AND repo_id=1 AND level='file' AND target_id='f:a.ts' ORDER BY commit_sha='x' DESC, id DESC LIMIT 1" | awk -F'\t' 'NR==1{print $7}')
echo "SMOKE migration_0002 explain_key=$plan"
[ "$plan" = "idx_reuse" ] || { echo "SMOKE FAIL: 复用查询未走 idx_reuse(实际 $plan)"; exit 1; }
mysql_q -e 'DROP DATABASE mig_check'

# web 也要能响应(不要求 200 的具体内容)
code=$(curl -s -o /dev/null -w '%{http_code}' --retry 15 --retry-delay 2 --retry-all-errors http://localhost:3000/ || true)
echo "SMOKE web_status=$code"
[ "$code" -ge 200 ] && [ "$code" -lt 500 ] || { echo "SMOKE FAIL: web 返回 $code"; exit 1; }

# 镜像内 Node 版本必须是 20
for s in api worker; do
  v=$(docker compose run --rm --no-deps -T "$s" node -p 'process.versions.node')
  echo "SMOKE ${s}_node=$v"
  [[ "$v" == 20.* ]] || { echo "SMOKE FAIL: $s 镜像 Node 不是 20"; exit 1; }
done

# 镜像内 tree-sitter 0.22.4 原生绑定:用 TypeScriptAnalyzer 真实解析一小段 TS,失败即 CI 失败
docker compose run --rm --no-deps -T worker node scripts/smoke-analyzer.mjs

# T-214:worker 镜像换成 glibc 后,onnxruntime-node 原生绑定能加载(CI 不下载模型,只验证运行时)
docker compose run --rm --no-deps -T -w /app/packages/rag worker \
  node -e "import('@huggingface/transformers').then((t)=>console.log('SMOKE onnx_runtime=ok transformers='+t.env.version))"

# 真实业务链路:提交 zustand 固定 commit → SSE 等 graph_ready/done → 校验图接口
node scripts/ci-smoke-analyze.mjs

# T-214:分析完成后 Qdrant collection code_chunks 有点(CI 为假向量);api-key 从 .env 读,只走请求头不打印
qkey=$(grep -E '^QDRANT_API_KEY=' .env | cut -d= -f2-)
qcount=$(curl -fsS -X POST -H "api-key: ${qkey}" -H 'content-type: application/json' \
  -d '{"exact":true}' http://127.0.0.1:6333/collections/code_chunks/points/count |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).result.count))")
echo "SMOKE qdrant_points=$qcount"
[ "$qcount" -gt 0 ] || { echo "SMOKE FAIL: code_chunks 没有向量"; exit 1; }

# inCycle 与图投影同源:hono 固定 commit 的已知环,/graph 边与 /nodes 都要 inCycle:true
node scripts/ci-smoke-cycles.mjs

# 经 web 代理访问 api(rewrites 必须指向 api,见 PR #18 评审)
node scripts/ci-smoke-web-proxy.mjs
echo "SMOKE PASS"
