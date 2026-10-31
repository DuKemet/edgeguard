FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN npm ci --no-audit --no-fund
RUN npm run build -w @edgeguard/gateway
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 10001 edgeguard && adduser -S -u 10001 -G edgeguard edgeguard
COPY --from=build --chown=edgeguard:edgeguard /app/node_modules ./node_modules
COPY --from=build --chown=edgeguard:edgeguard /app/apps/gateway/dist ./dist
COPY --from=build --chown=edgeguard:edgeguard /app/apps/gateway/package.json ./package.json
USER edgeguard
EXPOSE 8080
CMD ["node", "dist/index.js"]
