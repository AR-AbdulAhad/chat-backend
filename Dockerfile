# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r amai && useradd -r -g amai amai
COPY --from=build --chown=amai:amai /app/node_modules ./node_modules
COPY --from=build --chown=amai:amai /app/dist ./dist
COPY --from=build --chown=amai:amai /app/prisma ./prisma
COPY --from=build --chown=amai:amai /app/scripts/apply-migrations.mjs ./scripts/apply-migrations.mjs
COPY --from=build --chown=amai:amai /app/package.json ./package.json
USER amai
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node scripts/apply-migrations.mjs && node dist/src/server.js"]
