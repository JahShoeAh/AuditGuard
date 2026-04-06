#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed on this host" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available on this host" >&2
  exit 1
fi

IMAGE="${IMAGE:-}"
ENV_FILE="${ENV_FILE:-/opt/auditguard/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/auditguard/docker-compose.prod.yml}"
SCHEMA_FILE="${SCHEMA_FILE:-/opt/auditguard/schema.sql}"
PROJECT_NAME="${PROJECT_NAME:-auditguard}"
LEGACY_CONTAINER_NAME="${LEGACY_CONTAINER_NAME:-auditguard-devall}"

if [[ -z "${IMAGE}" ]]; then
  echo "IMAGE is required (for example: ghcr.io/<owner>/<repo>-devall:main)" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ENV_FILE not found: ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "COMPOSE_FILE not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

if [[ ! -f "${SCHEMA_FILE}" ]]; then
  echo "SCHEMA_FILE not found: ${SCHEMA_FILE}" >&2
  exit 1
fi

if ! grep -q '^POSTGRES_PASSWORD=' "${ENV_FILE}"; then
  echo "ENV_FILE must define POSTGRES_PASSWORD for PostgreSQL startup" >&2
  exit 1
fi

if [[ -n "${LEGACY_CONTAINER_NAME}" ]] && docker ps -a --format '{{.Names}}' | grep -qx "${LEGACY_CONTAINER_NAME}"; then
  echo "Stopping legacy container: ${LEGACY_CONTAINER_NAME}"
  docker stop "${LEGACY_CONTAINER_NAME}" || true
  docker rm "${LEGACY_CONTAINER_NAME}" || true
fi

echo "Deploying stack with docker compose..."
export BACKEND_IMAGE="${IMAGE}"
export ENV_FILE="${ENV_FILE}"
export SCHEMA_FILE="${SCHEMA_FILE}"

docker compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" pull
docker compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --remove-orphans

echo "Stack status:"
docker compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps
