#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

SNAPSHOT=${1:-repro-clean-db.sql.gz}

if [ ! -s "$SNAPSHOT" ]; then
  echo "Missing DB snapshot: $SNAPSHOT" >&2
  exit 1
fi

gzip -t "$SNAPSHOT"
gunzip -c "$SNAPSHOT" | docker compose exec -T database mariadb -uroot -proot shopware
docker compose exec web php bin/console cache:clear:all >/dev/null
docker compose exec web php bin/console cache:clear:http >/dev/null
