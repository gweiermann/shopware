#!/usr/bin/env bash
# Snapshot the clean post-install DB ONCE (after provision, before the build agent). build-verify
# restores it before each seed, so every repro attempt starts fresh — re-seeds never collide with
# a prior attempt's rows (composite unique keys, duplicate entries, "already exists").
#
# Env: DATABASE_URL (job env), OUT (default repro-clean-db.sql.gz).
set -euo pipefail

OUT=${OUT:-repro-clean-db.sql.gz}
# shellcheck source=db-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/db-env.sh"

mysqldump --no-tablespaces --single-transaction --skip-lock-tables \
  -h"$DBH" -P"$DBP" -u"$DBU" ${DBPW:+-p"$DBPW"} "$DBN" | gzip > "$OUT"
echo "DB snapshot → $OUT ($(du -h "$OUT" | cut -f1))"
