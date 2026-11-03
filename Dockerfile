FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
COPY --chown=node:node web/ ./web/
COPY --chown=node:node design-system/tokens.css design-system/components.css ./design-system/
COPY --chown=node:node app/ ./app/
COPY --chown=node:node voice/ ./voice/
COPY --chown=node:node crm/ ./crm/
COPY --chown=node:node sms/ ./sms/
COPY --chown=node:node specialists/ ./specialists/
COPY --chown=node:node context/ ./context/
COPY --chown=node:node decisions/ ./decisions/
COPY --chown=node:node queue/ ./queue/
COPY --chown=node:node reply/ ./reply/
COPY --chown=node:node db/ ./db/
COPY --chown=node:node scripts/ ./scripts/
ENV NODE_ENV=production HOST=0.0.0.0
USER node
CMD ["npm", "start"]
