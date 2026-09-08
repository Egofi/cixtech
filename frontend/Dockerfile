FROM node:20-alpine AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json next.config.mjs verify.mjs ./
COPY types ./types
COPY lib ./lib
COPY components ./components
COPY app ./app
COPY public ./public

RUN pnpm typecheck && pnpm exec next build && node verify.mjs

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /build/out /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.d/99-cixtech-config.sh

USER root
RUN chmod +x /docker-entrypoint.d/99-cixtech-config.sh \
 && sed -i 's|^exec "\$@"$|:|' /docker-entrypoint.d/99-cixtech-config.sh \
 && chown -R 101:101 /usr/share/nginx/html /etc/nginx/conf.d
USER 101

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
