#!/bin/sh
set -eu

echo "[cixtech-docker] Running schema migrations..."
node apps/api/dist/migrate.mjs

echo "[cixtech-docker] Migrations completed cleanly. Starting cixtech engine..."
exec "$@"
