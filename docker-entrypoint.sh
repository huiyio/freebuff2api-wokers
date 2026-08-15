#!/usr/bin/env sh
set -eu

# Allow one-off maintenance commands such as the legacy credential importer.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

mode="${WORKER_UPDATE_MODE:-bundled}"
worker_url="${WORKER_URL:-https://raw.githubusercontent.com/pingmike2/freebuff2api-wokers/main/worker.js}"
worker_tmp="/tmp/worker.js"

case "$mode" in
  bundled)
    echo "[entrypoint] using bundled worker.js"
    ;;
  latest)
    if [ -z "${WORKER_SHA256:-}" ]; then
      echo "[entrypoint] WORKER_SHA256 is required when WORKER_UPDATE_MODE=latest" >&2
      exit 1
    fi
    if ! printf '%s' "$WORKER_SHA256" | grep -Eq '^[0-9a-fA-F]{64}$'; then
      echo "[entrypoint] WORKER_SHA256 must be exactly 64 hexadecimal characters" >&2
      exit 1
    fi
    echo "[entrypoint] checking configured worker.js source"
    if wget -q --timeout=15 -O "$worker_tmp" "$worker_url" \
      && node --check "$worker_tmp" >/dev/null \
      && echo "${WORKER_SHA256}  ${worker_tmp}" | sha256sum -c - >/dev/null; then
      cp "$worker_tmp" /app/worker.js
      echo "[entrypoint] worker.js updated"
    else
      echo "[entrypoint] update failed integrity or syntax validation; using bundled worker.js"
    fi
    ;;
  *)
    echo "[entrypoint] WORKER_UPDATE_MODE must be bundled or latest" >&2
    exit 1
    ;;
esac

exec node /app/server.js
