# Backend Dockerfile (NestJS) — this is an npm-workspaces monorepo, so the
# Docker BUILD CONTEXT must be the repo root, not apps/api. On Render: set
# Root Directory blank, Dockerfile Path to apps/api/Dockerfile, and Docker
# Build Context Directory to "." (repo root).
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api ./apps/api
RUN npm run build:api && npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./package.json
EXPOSE 4000
CMD ["node", "dist/main.js"]
