FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run typecheck && bun test && bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production CONFIG_DIR=/config VAULT_ROOT=/vault PORT=3000
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir -p /config /vault && chown -R bun:bun /app /config /vault
COPY --from=build --chown=bun:bun /app/src/server ./src/server
COPY --from=build --chown=bun:bun /app/src/shared ./src/shared
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/noise.gif /app/line-BG.png ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "src/server/index.ts"]