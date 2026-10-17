# hordes3d game server — plain Node + ws, no build step needed.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./server/
COPY shared/ ./shared/
COPY client/ ./client/
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server/index.js"]
