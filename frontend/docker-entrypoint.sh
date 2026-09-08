#!/bin/sh
set -eu

# One built image, many environments: the bundle is immutable and the API it talks
# to is written in here at start-up. Baking the base URL at build time would mean
# a separate image per environment, and an image promoted from staging to
# production would still point at staging.
API_BASE="${CIXTECH_API_BASE:-}"

cat > /usr/share/nginx/html/config.js <<CONFIG
// Generated at container start-up from CIXTECH_API_BASE. Do not edit.
window.CIXTECH = { apiBase: "${API_BASE}" };
CONFIG

# The CSP must name the API origin explicitly, or the browser blocks every
# cross-origin fetch the consoles make. Empty base = same origin = 'self'.
if [ -n "$API_BASE" ]; then
  CONNECT_SRC="'self' ${API_BASE}"
else
  CONNECT_SRC="'self'"
fi

# script-src needs 'unsafe-inline'. Next inlines its RSC bootstrap payload
# (self.__next_f.push(...)) into every exported page, and a static export cannot
# use a nonce — a nonce has to be minted per request, and there is no request-time
# process here by design. Hashing is not viable either: the inline content differs
# per page and changes on every build.
#
# What keeps that acceptable is the layer above it. These consoles are React, which
# escapes interpolated values by default, and the codebase contains no
# dangerouslySetInnerHTML (verify.mjs fails the build if one appears). The previous
# hand-rolled consoles built HTML by string concatenation behind a bespoke esc()
# helper that did not escape single quotes — so the injection surface this policy
# is defending is materially smaller than it was, not larger.
cat > /etc/nginx/conf.d/security-headers.inc <<HEADERS
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src ${CONNECT_SRC}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
HEADERS

echo "[cixtech-web] serving consoles; API base: ${API_BASE:-<same origin>}"
exec "$@"
