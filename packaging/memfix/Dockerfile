# Happy Agent v0.4.100 plus the bounded-MCP-schema serialization fix, built as a
# linux-x64 binary and shipped in an otherwise empty image. Other images take it with
#   COPY --from=<registry>/admin/happy-agent:0.4.100-memfix.1 /happy-agent /usr/local/bin/happy-agent
# until the fix is in an upstream release.
#
# Build from the repository root:
#   docker build -f packaging/memfix/Dockerfile -t happy-agent:0.4.100-memfix.1 .
#
# The release build compiles a patched libsql binding with Rust and rebuilds a patched
# Parcel watcher. Neither changes between v0.4.100 and this branch, so the two files
# in prebuilt/ are the exact ones the official v0.4.100 binary ships, taken from its
# extracted assets (checksums in prebuilt/SHA256SUMS).
FROM node:22-trixie-slim AS build
ARG HAPPY_AGENT_RELEASE_VERSION=0.4.100-memfix.1
# python3 and a compiler for the native installs pnpm runs (node-gyp); their output for
# the Parcel watcher is replaced by the prebuilt file below.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git unzip \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
RUN cd packaging/memfix/prebuilt && sha256sum -c SHA256SUMS
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN pnpm install --frozen-lockfile
RUN set -eu; \
    mkdir -p packages/happy-agent/native/target/linux-x64; \
    cp packaging/memfix/prebuilt/libsql.node packages/happy-agent/native/target/linux-x64/libsql.node; \
    watcher=$(cd packages/happy-agent-modules && node -p 'require("path").dirname(require.resolve("@parcel/watcher/package.json"))'); \
    mkdir -p "$watcher/build/linux-x64"; \
    cp packaging/memfix/prebuilt/watcher.node "$watcher/build/linux-x64/watcher.node"
RUN pnpm build
RUN cd packages/happy-agent \
    && HAPPY_AGENT_RELEASE_VERSION="$HAPPY_AGENT_RELEASE_VERSION" \
       pnpm dlx bun@1.4.2 scripts/build-binary.ts --target linux-x64 \
    && ./dist/bin/happy-agent-linux-x64 --version

FROM scratch
COPY --from=build /src/packages/happy-agent/dist/bin/happy-agent-linux-x64 /happy-agent
