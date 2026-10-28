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

# 镜像内 tree-sitter 原生绑定加载并解析一段 TS(依赖 #7 引入 tree-sitter;未引入时跳过并明确打印)
if docker compose run --rm --no-deps -T worker sh -c 'ls -d /app/node_modules/.pnpm/tree-sitter@* >/dev/null 2>&1'; then
  docker compose run --rm --no-deps -T worker sh -c 'cd /app/node_modules/.pnpm/node_modules && node -e "
    const P=require(\"./tree-sitter\"); const TS=require(\"./tree-sitter-typescript\").typescript;
    const p=new P(); p.setLanguage(TS);
    const t=p.parse(\"import { a } from \\\"./a\\\"; export const b: number = 1;\");
    if (t.rootNode.hasError) { console.error(\"parse error\"); process.exit(1); }
    console.log(\"SMOKE tree_sitter_ok root=\"+t.rootNode.type+\" children=\"+t.rootNode.childCount);
  "'
else
  echo "SMOKE tree_sitter=SKIPPED(main 上尚无 tree-sitter 依赖,待 #7 合并后生效)"
fi
echo "SMOKE PASS"
