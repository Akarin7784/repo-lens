#!/usr/bin/env bash
# T-005 冒烟:真实构建镜像 → compose 起服务 → 轮询 /health → 镜像内 Node/原生绑定检查。
set -euo pipefail
TIMEOUT="${SMOKE_TIMEOUT:-120}"
[ -f .env ] || cp .env.example .env

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
echo "SMOKE PASS"
