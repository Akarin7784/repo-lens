# 构建上下文为仓库根目录
# T-214:onnxruntime-node 只有 glibc 预编译,worker 从 alpine 换成 bookworm-slim
FROM node:20-bookworm-slim AS build
# tree-sitter 无预编译时需本地编译
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@repolens/worker...

# embedding 模型(D4:Xenova/multilingual-e5-small,fp32)在构建时下载,运行时不联网拉模型。
# 只取 fp32 推理需要的 5 个文件(约 490 MB),固定 revision。
# EMBEDDING_MODEL_DOWNLOAD=0 时跳过(CI 冒烟用 EMBEDDER=fake,不需要模型)。
FROM node:20-bookworm-slim AS model
ARG EMBEDDING_MODEL_DOWNLOAD=1
# 可换镜像站(如 https://hf-mirror.com);路径须与 huggingface.co 相同:{base}/{repo}/resolve/{revision}/{file}
ARG EMBEDDING_MODEL_BASE_URL=https://huggingface.co
ARG EMBEDDING_MODEL_REPO=Xenova/multilingual-e5-small
ARG EMBEDDING_MODEL_REVISION=761b726dd34fb83930e26aab4e9ac3899aa1fa78
# 与上面 revision 对应的 sha256(「哈希 文件」成对、空白分隔);换 repo/revision 必须同时更新,否则校验失败、构建中止
ARG EMBEDDING_MODEL_SHA256="\
cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1  config.json \
0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39  tokenizer.json \
a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b  tokenizer_config.json \
d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7  special_tokens_map.json \
4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff  onnx/model.onnx"
RUN mkdir -p /models && if [ "$EMBEDDING_MODEL_DOWNLOAD" = "1" ]; then \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && d="/models/$EMBEDDING_MODEL_REPO" && mkdir -p "$d/onnx" && cd "$d" \
    && for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json onnx/model.onnx; do \
      curl -fsSL --connect-timeout 30 --max-time 900 --retry 3 --retry-all-errors -o "$f" \
        "${EMBEDDING_MODEL_BASE_URL%/}/$EMBEDDING_MODEL_REPO/resolve/$EMBEDDING_MODEL_REVISION/$f" || exit 1; \
    done \
    && printf '%s  %s\n' $EMBEDDING_MODEL_SHA256 > /tmp/sums \
    && sha256sum -c /tmp/sums || { echo "模型文件 sha256 校验失败" >&2; exit 1; }; \
  fi

FROM node:20-bookworm-slim
# 流水线用 git 浅克隆
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY --from=model /models /app/models
ENV EMBEDDING_MODEL_DIR=/app/models
# 运行时带上模型 revision:进 embedding digest,换 revision 后旧向量不复用
ARG EMBEDDING_MODEL_REVISION=761b726dd34fb83930e26aab4e9ac3899aa1fa78
ENV EMBEDDING_MODEL_REVISION=$EMBEDDING_MODEL_REVISION
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
