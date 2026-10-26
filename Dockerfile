FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@11.25.0
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @actionledger/core build && pnpm --filter @actionledger/runtime build && pnpm --filter @actionledger/provider build
RUN pnpm --filter @actionledger/runtime deploy --legacy --prod /opt/gateway && pnpm --filter @actionledger/provider deploy --legacy --prod /opt/provider

FROM node:24-bookworm-slim AS gateway
WORKDIR /app
COPY --from=build --chown=node:node /opt/gateway ./
COPY --chown=node:node deploy/runtime.manifest.json /app/config/runtime.example.json
USER node
CMD ["node","dist/cli.js","http"]

FROM node:24-bookworm-slim AS provider
WORKDIR /app
COPY --from=build --chown=node:node /opt/provider ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data
CMD ["node","dist/index.js"]
