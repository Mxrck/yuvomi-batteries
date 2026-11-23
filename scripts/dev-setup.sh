#!/bin/sh
# Seeds a fresh dev instance (docker-compose.dev.yml): the first admin, then one ordinary member
# so the read-only page can be checked. Safe to re-run: existing accounts are skipped.
#
#   admin / batteries-dev   (admin)
#   angel / batteries-dev   (member)
#
# Leaves cookie jars for both in .dev/jars/ (used by scripts/browser/*.mjs).
set -eu
BASE="${YUVOMI_URL:-http://localhost:3300}"
PASS="batteries-dev"
DIR="$(cd "$(dirname "$0")/.." && pwd)/.dev/jars"
mkdir -p "$DIR"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

post() { # jar path json [extra curl args...]
  jar=$1; path=$2; body=$3; shift 3
  curl -s -b "$jar" -c "$jar" -o "$OUT" -w '%{http_code}' -X POST "$BASE$path" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" "$@" -d "$body"
}

# 1. First-run admin (the route answers 404/403 once any user exists).
code=$(post "$DIR/admin.jar" /api/v1/auth/setup "{\"username\":\"admin\",\"display_name\":\"Admin\",\"password\":\"$PASS\",\"language\":\"es\",\"timezone\":\"America/Merida\"}")
case "$code" in
  200|201) echo "admin: created" ;;
  404|403) echo "admin: already exists" ;;
  *) echo "admin: unexpected HTTP $code"; cat "$OUT"; echo; exit 1 ;;
esac

login() { # name jar
  code=$(post "$2" /api/v1/auth/login "{\"username\":\"$1\",\"password\":\"$PASS\"}")
  [ "$code" = "200" ] || { echo "login $1 failed: HTTP $code"; cat "$OUT"; echo; exit 1; }
}
login admin "$DIR/admin.jar"
CSRF=$(awk '$6=="csrf-token"{print $7}' "$DIR/admin.jar")

# Dev language: Spanish, the household's, so the page's locale handling is exercised.
set_es() { # jar
  code=$(curl -s -o "$OUT" -w '%{http_code}' -b "$1" -X PATCH "$BASE/api/v1/preferences" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" -H "X-CSRF-Token: $(awk '$6=="csrf-token"{print $7}' "$1")" \
    -d '{"language":"es"}')
  [ "$code" = "200" ] || echo "language for $1: HTTP $code (not fatal)"
}
set_es "$DIR/admin.jar"

# 2. One member through the admin-only route.
code=$(post "$DIR/admin.jar" /api/v1/auth/users "{\"username\":\"angel\",\"display_name\":\"Ángel\",\"password\":\"$PASS\"}" -H "X-CSRF-Token: $CSRF")
case "$code" in
  200|201) echo "angel: created" ;;
  409) echo "angel: already exists" ;;
  400) if grep -q -i "taken\|exists" "$OUT"; then echo "angel: already exists"; else echo "angel: HTTP 400"; cat "$OUT"; echo; exit 1; fi ;;
  *) echo "angel: unexpected HTTP $code"; cat "$OUT"; echo; exit 1 ;;
esac
login angel "$DIR/angel.jar"
set_es "$DIR/angel.jar"
echo "jars in $DIR - every account uses password '$PASS'"
