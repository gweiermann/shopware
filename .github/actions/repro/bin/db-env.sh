#!/usr/bin/env bash
# Sourced helper: parse $DATABASE_URL (exported by setup-shopware, present in the build-repro
# job env) into DBH / DBP / DBU / DBPW / DBN for mysql / mysqldump. Requires php on PATH (the
# provisioned shop has it). Mirrors the parse the provision action uses for the access key.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"
#   mysql -h"$DBH" -P"$DBP" -u"$DBU" ${DBPW:+-p"$DBPW"} "$DBN"
: "${DATABASE_URL:?DATABASE_URL is required}"
eval "$(php -r '$u=parse_url(getenv("DATABASE_URL")); printf("DBH=%s DBP=%s DBU=%s DBPW=%s DBN=%s",
  $u["host"]??"127.0.0.1", $u["port"]??3306, $u["user"]??"root", $u["pass"]??"", ltrim($u["path"]??"/","/"));')"
