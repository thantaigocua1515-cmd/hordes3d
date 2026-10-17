# hordes3d game server — plain Node + ws, no build step needed.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./server/
COPY shared/ ./shared/
COPY client/ ./client/
EXPOSE 3000
# NOTE: do NOT hardcode PORT here — Render/Fly inject their own PORT at
# runtime and it must win. The server falls back to 3000 when unset.
CMD ["node", "server/index.js"]
