#!/usr/bin/env bash
# T-205:演示前预分析 hono、zustand、zod、trpc。
# 用法:API_BASE=http://localhost:4000 TIMEOUT_MIN=15 bash scripts/demo-prep.sh
# 依赖:curl、node(仅用于解析 JSON)。需要一个已运行的完整环境(api + worker + MySQL + Redis)。
# 接口:POST /api/repos {repoUrl} → {repoId, jobId, status, repo, commitSha};
#       GET /api/repos/:id → {status, stage, progress, stats:{files,modules,edges}, error}
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4000}"
TIMEOUT_MIN="${TIMEOUT_MIN:-15}"
POLL_SEC="${POLL_SEC:-5}"
REPOS=(
  https://github.com/honojs/hono
  https://github.com/pmndrs/zustand
  https://github.com/colinhacks/zod
  https://github.com/trpc/trpc
)

echo "提醒:api 需以 RATE_LIMIT_NEW_REPOS_PER_HOUR>=50 启动(默认 5,四个仓库加彩排会被限流 429)。"
echo "API_BASE=$API_BASE 每个仓库超时 ${TIMEOUT_MIN} 分钟"

json() { # json <expr>,stdin 为 JSON,expr 以 j 为根对象
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let j;try{j=JSON.parse(s)}catch{j={}};const v=($1);process.stdout.write(v==null?'':String(v))})"
}

failed=()
for url in "${REPOS[@]}"; do
  name="${url#https://github.com/}"
  t0=$(date +%s)
  resp_file=$(mktemp)
  code=$(curl -sS -o "$resp_file" -w '%{http_code}' -X POST "$API_BASE/api/repos" \
    -H 'content-type: application/json' -d "{\"repoUrl\":\"$url\"}") || code=000
  body=$(cat "$resp_file"); rm -f "$resp_file"
  if [[ "$code" != 200 && "$code" != 202 ]]; then
    echo "FAIL $name:提交返回 HTTP $code $body"
    failed+=("$name"); continue
  fi
  id=$(json 'j.repoId' <<<"$body")
  echo "提交 $name → repoId=$id jobId=$(json 'j.jobId' <<<"$body") commit=$(json 'j.commitSha' <<<"$body")"

  deadline=$((t0 + TIMEOUT_MIN * 60)); status=""; st=""
  while :; do
    st=$(curl -sS "$API_BASE/api/repos/$id" || true)
    status=$(json 'j.status' <<<"$st")
    [[ "$status" == "done" || "$status" == failed ]] && break
    if (( $(date +%s) >= deadline )); then status=timeout; break; fi
    sleep "$POLL_SEC"
  done
  secs=$(( $(date +%s) - t0 ))
  if [[ "$status" != "done" ]]; then
    echo "FAIL $name:status=$status stage=$(json 'j.stage' <<<"$st") error=$(json 'j.error' <<<"$st") 耗时 ${secs}s"
    failed+=("$name"); continue
  fi
  nodes=$(curl -sS "$API_BASE/api/repos/$id/graph" | json 'Array.isArray(j.nodes)?j.nodes.length:"?"' || echo '?')
  echo "OK   $name:耗时 ${secs}s 文件 $(json 'j.stats.files' <<<"$st") 模块 $(json 'j.stats.modules' <<<"$st") 边 $(json 'j.stats.edges' <<<"$st") 根层节点 $nodes"
done

if (( ${#failed[@]} )); then
  echo "预分析失败:${failed[*]}" >&2
  exit 1
fi
echo "四个仓库均已 done,演示时只走复用路径。"
