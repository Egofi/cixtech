#!/bin/sh
set -e

echo "[cixtech-docker] Starting entrypoint script..."

# Wait for PostgreSQL if DATABASE_URL is defined
if [ -n "$DATABASE_URL" ]; then
  echo "[cixtech-docker] Verifying database connectivity..."
fi

# Run database migrations before booting the engine
echo "[cixtech-docker] Running schema migrations (pnpm db:migrate)..."
node apps/api/migrate.mjs

echo "[cixtech-docker] Migrations completed cleanly. Starting cixtech engine..."
exec "$@"
