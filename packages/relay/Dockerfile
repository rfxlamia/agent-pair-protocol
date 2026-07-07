# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/

RUN pnpm install --frozen-lockfile --filter @agentpair/relay...

COPY packages/protocol packages/protocol
COPY packages/relay packages/relay

RUN npm install -g tsx@4.20.3

RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=3001
ENV AGENTPAIR_RELAY_DB=/data/relay.db

EXPOSE 3001

CMD ["tsx", "packages/relay/src/start.ts"]
