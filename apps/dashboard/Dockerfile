FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_BASE=/api/admin
ENV VITE_API_BASE=$VITE_API_BASE
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN npm ci --no-audit --no-fund
RUN npm run build -w @edgeguard/dashboard

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY infra/nginx/dashboard.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
