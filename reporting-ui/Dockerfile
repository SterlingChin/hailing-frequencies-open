# Build context is the repository root, or the sanitized deployment bundle
# containing reporting-ui/ and design-system/.
FROM node:22-slim AS build
WORKDIR /workspace/reporting-ui
COPY reporting-ui/package.json reporting-ui/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY design-system/tokens.css design-system/components.css /workspace/design-system/
COPY reporting-ui/index.html ./
COPY reporting-ui/public ./public
COPY reporting-ui/src ./src
COPY reporting-ui/server ./server
COPY reporting-ui/tests ./tests
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 LIVE_ENABLED=false
WORKDIR /app
COPY --from=build /workspace/reporting-ui/package.json /workspace/reporting-ui/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /workspace/reporting-ui/dist ./dist
COPY --from=build /workspace/reporting-ui/server ./server
# Entrypoint initializes mounted storage and drops to node before serving.
USER root
EXPOSE 8080
CMD ["node", "server/entrypoint.mjs", "--production"]
