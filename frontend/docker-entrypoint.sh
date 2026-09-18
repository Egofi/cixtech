#!/bin/sh
set -eu

# Empty (the default) means "proxy /v1, /auth and /admin/api to the API from this
# origin". Setting it means "the browser calls that origin directly", which is the
# older cross-origin arrangement and still supported.
API_BASE="${CIXTECH_API_BASE:-}"

# Where nginx forwards to in proxy mode. Container-to-container by default, so it
# is never a URL the browser has to be able to reach.
API_UPSTREAM="${CIXTECH_API_UPSTREAM:-http://api:3000}"

# Docker's embedded DNS. Used so the upstream is resolved per request rather than
# once at startup: with a literal hostname in proxy_pass, nginx refuses to start
# at all if the API is not up yet, which turns a slow dependency into a crash loop.
API_RESOLVER="${CIXTECH_API_RESOLVER:-127.0.0.11}"

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

if [ -n "$API_BASE" ]; then
  cat > /etc/nginx/conf.d/api-proxy.inc <<'DIRECT'
location /v1/         { return 404 '{"error":{"code":"NOT_FOUND","message":"CIXTECH_API_BASE is set; the console calls the API directly"}}'; }
location /auth/       { return 404 '{"error":{"code":"NOT_FOUND","message":"CIXTECH_API_BASE is set; the console calls the API directly"}}'; }
location /admin/api/  { return 404 '{"error":{"code":"NOT_FOUND","message":"CIXTECH_API_BASE is set; the console calls the API directly"}}'; }
DIRECT
  echo "[cixtech-web] serving consoles; browser calls the API directly at ${API_BASE}"
else
  # $request_uri is required because proxy_pass with a variable does not carry the
  # original URI. It is the raw request line, so the path reaches the API exactly
  # as sent -- no normalisation that could make nginx and Fastify disagree about
  # which route was asked for.
  cat > /etc/nginx/conf.d/api-proxy.inc <<PROXY
resolver ${API_RESOLVER} valid=10s ipv6=off;

location /v1/ {
  set \$cixtech_api "${API_UPSTREAM}";
  proxy_pass \$cixtech_api\$request_uri;
  include /etc/nginx/conf.d/api-proxy-headers.inc;
}

location /auth/ {
  set \$cixtech_api "${API_UPSTREAM}";
  proxy_pass \$cixtech_api\$request_uri;
  include /etc/nginx/conf.d/api-proxy-headers.inc;
}

location /admin/api/ {
  set \$cixtech_api "${API_UPSTREAM}";
  proxy_pass \$cixtech_api\$request_uri;
  include /etc/nginx/conf.d/api-proxy-headers.inc;
}

location /docs {
  set \$cixtech_api "${API_UPSTREAM}";
  proxy_pass \$cixtech_api\$request_uri;
  include /etc/nginx/conf.d/api-proxy-headers.inc;
}
PROXY

  # X-Forwarded-For is what lets the API see the real caller instead of this
  # container -- without it the per-IP auth rate limit (CX-08) buckets everyone
  # together and the sign-in log records nginx. The API only believes it when
  # CIXTECH_TRUST_PROXY says so, which is only safe while the API is not
  # separately reachable.
  #
  # The incoming value is replaced rather than appended, because a client-supplied
  # X-Forwarded-For would otherwise be prefixed to the chain and taken as the
  # origin address.
  cat > /etc/nginx/conf.d/api-proxy-headers.inc <<'HDRS'
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_read_timeout 60s;
proxy_send_timeout 60s;

# The API answers with its own CORS, cache and security headers; nothing here
# should add a second set for the browser to reconcile.
proxy_pass_request_headers on;
HDRS

  echo "[cixtech-web] serving consoles; proxying /v1, /auth, /admin/api and /docs to ${API_UPSTREAM}"
fi

exec "$@"
