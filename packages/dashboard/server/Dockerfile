FROM node:20-alpine AS base
WORKDIR /app

# Copy root manifest and lock file — installs all workspace deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy only the files this service needs
COPY packages/sdk/db/           ./packages/sdk/db/
COPY packages/dashboard/server/ ./packages/dashboard/server/

EXPOSE ${API_PORT:-3002}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:${API_PORT:-3002}/health || exit 1

CMD ["node", "packages/dashboard/server/index.js"]
