#!/bin/sh
set -e

# Entrypoint for the agent sandbox image (docker/agent.Dockerfile).
#
# Rootless CA trust: the gateway's MITM CA arrives as a mounted file (the
# container-config payload names it in NODE_EXTRA_CA_CERTS). Inside the
# sandbox every TLS handshake presents the gateway's certificate — egress is
# gateway-only (§3.4) — so this one CA is the only trust anyone needs:
# - NODE_EXTRA_CA_CERTS: the supervisor's Node runtime (set by the payload).
# - SSL_CERT_FILE: the jcode runtime (rustls-native-certs honors it; verified).
# - CURL_CA_BUNDLE / GIT_SSL_CAINFO: the agent's common tools.
# System-store installation (update-ca-certificates, needs root) arrives with
# step 3's runner-controlled spawn.
CA_FILE="${NODE_EXTRA_CA_CERTS:-/tmp/onecli-gateway-ca.pem}"
if [ -f "$CA_FILE" ]; then
  export SSL_CERT_FILE="$CA_FILE"
  export CURL_CA_BUNDLE="$CA_FILE"
  export GIT_SSL_CAINFO="$CA_FILE"
else
  echo "agent-entrypoint: no CA file at $CA_FILE — TLS through the gateway will fail" >&2
fi

exec node apps/sandbox-supervisor/dist/index.mjs
