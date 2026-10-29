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
ARG EMBEDDING_MODEL_REPO=Xenova/multilingual-e5-small
ARG EMBEDDING_MODEL_REVISION=761b726dd34fb83930e26aab4e9ac3899aa1fa78
RUN mkdir -p /models && if [ "$EMBEDDING_MODEL_DOWNLOAD" = "1" ]; then \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && d="/models/$EMBEDDING_MODEL_REPO" && mkdir -p "$d/onnx" \
    && for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json onnx/model.onnx; do \
      curl -fsSL --retry 3 -o "$d/$f" \
        "https://huggingface.co/$EMBEDDING_MODEL_REPO/resolve/$EMBEDDING_MODEL_REVISION/$f" || exit 1; \
    done; \
  fi

FROM node:20-bookworm-slim
# 流水线用 git 浅克隆
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY --from=model /models /app/models
ENV EMBEDDING_MODEL_DIR=/app/models
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
