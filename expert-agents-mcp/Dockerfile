FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production EXPERT_ENV_FILE="" EXPERT_SANDBOX=local EXPERT_MCP_HOST=0.0.0.0 EXPERT_MCP_ALLOW_NONLOOPBACK=true
USER node
CMD ["node", "dist/index.js"]
