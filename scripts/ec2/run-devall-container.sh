#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed on this host" >&2
  exit 1
fi

IMAGE="${IMAGE:-}"
CONTAINER_NAME="${CONTAINER_NAME:-auditguard-devall}"
ENV_FILE="${ENV_FILE:-/opt/auditguard/.env}"
HOST_PORT="${HOST_PORT:-}"
CONTAINER_PORT="${CONTAINER_PORT:-}"

if [[ -z "${IMAGE}" ]]; then
  echo "IMAGE is required (for example: ghcr.io/<owner>/<repo>-devall:main)" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ENV_FILE not found: ${ENV_FILE}" >&2
  exit 1
fi

echo "Pulling image: ${IMAGE}"
docker pull "${IMAGE}"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping existing container: ${CONTAINER_NAME}"
  docker stop "${CONTAINER_NAME}" || true
  docker rm "${CONTAINER_NAME}" || true
fi

echo "Starting container: ${CONTAINER_NAME}"
docker_args=(
  -d
  --name "${CONTAINER_NAME}"
  --restart unless-stopped
  --env-file "${ENV_FILE}"
)

if [[ -n "${HOST_PORT}" && -n "${CONTAINER_PORT}" ]]; then
  docker_args+=(-p "${HOST_PORT}:${CONTAINER_PORT}")
fi

docker run "${docker_args[@]}" "${IMAGE}"

echo "Container started:"
docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
