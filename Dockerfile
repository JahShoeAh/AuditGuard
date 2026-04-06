# Multi-stage Node.js build for backend services (orchestrator, agents, events-api,
# static-analysis-service, fuzzer-service)
FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Install all workspace deps
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/events-api/package.json              ./packages/events-api/
COPY packages/static-analysis-service/package.json ./packages/static-analysis-service/
COPY packages/fuzzer-service/package.json           ./packages/fuzzer-service/
COPY packages/sdk/package.json                      ./packages/sdk/
COPY agents/package.json                            ./agents/
COPY orchestrator/package.json                      ./orchestrator/
RUN npm ci --ignore-scripts

# Copy source
FROM deps AS prod
COPY packages/ ./packages/
COPY agents/   ./agents/
COPY orchestrator/ ./orchestrator/

# Default CMD is overridden per-service in docker-compose.yml
CMD ["node", "orchestrator/src/index.js"]
