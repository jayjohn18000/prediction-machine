# Dedicated MM orchestrator runtime (no api/observer entrypoint branching).
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8790

ENTRYPOINT ["node", "scripts/mm/run-mm-orchestrator.mjs"]
