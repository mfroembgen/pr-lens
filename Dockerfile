FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:canvas
RUN bun build packages/canvas-local/src/bin.ts --target=bun --outfile=/out/bin.js
RUN cp -R packages/canvas-local/dist/web /out/web
RUN cp packages/canvas-local/node_modules/zod/LICENSE /out/LICENSE.zod

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/mfroembgen/pr-lens" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
USER root
RUN mkdir -p /data && chown 1000:1000 /data
COPY --from=build --chown=bun:bun /out /app
COPY LICENSE /app/LICENSE
COPY packages/canvas-local/LICENSE /app/LICENSE.canvas
USER bun
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATABASE_PATH=/data/pr-lens.sqlite WEB_DIR=/app/web
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e 'const r=await fetch("http://127.0.0.1:8080/healthz");if(!r.ok)process.exit(1)'
ENTRYPOINT ["bun", "/app/bin.js"]
