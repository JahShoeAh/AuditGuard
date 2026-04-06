# Stage 1: Build Vite app
FROM node:24-alpine AS builder
WORKDIR /app

ARG VITE_EVENTS_API_URL=http://localhost:3001
ENV VITE_EVENTS_API_URL=$VITE_EVENTS_API_URL

COPY package.json package-lock.json ./
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/sdk/ ./packages/sdk/
RUN npm ci --workspace=packages/dashboard --ignore-scripts

COPY packages/dashboard/ ./packages/dashboard/
RUN npm --prefix packages/dashboard run build

# Stage 2: Nginx static server
FROM nginx:alpine
COPY --from=builder /app/packages/dashboard/dist /usr/share/nginx/html
COPY packages/dashboard/nginx.conf /etc/nginx/conf.d/default.conf 2>/dev/null || true
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
