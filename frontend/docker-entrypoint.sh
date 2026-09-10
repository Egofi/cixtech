#!/bin/sh
set -eu

API_BASE="${CIXTECH_API_BASE:-}"

cat > /usr/share/nginx/html/config.js <<CONFIG
window.CIXTECH = { apiBase: "${API_BASE}" };
CONFIG

if [ -n "$API_BASE" ]; then
  CONNECT_SRC="'self' ${API_BASE}"
else
  CONNECT_SRC="'self'"
fi

cat > /etc/nginx/conf.d/security-headers.inc <<HEADERS
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src ${CONNECT_SRC}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
HEADERS

echo "[cixtech-web] serving consoles; API base: ${API_BASE:-<same origin>}"
exec "$@"
