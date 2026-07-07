# syntax=docker/dockerfile:1
# Production relay image — uses published @agentpair/protocol (no monorepo pnpm build).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/relay/package.standalone.json package.json
RUN npm install

COPY packages/relay/src ./src

RUN npm install -g tsx@4.20.3

RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=3001
ENV AGENTPAIR_RELAY_DB=/data/relay.db

EXPOSE 3001

CMD ["tsx", "src/start.ts"]
