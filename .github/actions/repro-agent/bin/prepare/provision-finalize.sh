#!/usr/bin/env bash
set -euo pipefail

if [ "${PREVIOUS_OUTCOME:-success}" != success ]; then
  echo "::error::shopware/setup-shopware failed; provisioning cannot continue."
  exit 1
fi

SHOP_DIR=${SHOP_DIR:-shop}
DEMODATA=${DEMODATA:-false}

{
  echo "SHOPWARE_HTTP_CACHE_ENABLED=0"
  echo "SHOPWARE_DISABLE_UPDATE_CHECK=true"
  echo "BLUE_GREEN_DEPLOYMENT=1"
  echo "MCP_SERVER=1"
} >> "$GITHUB_ENV"

mcp_available=false
mcp_access_key=""
mcp_secret_access_key=""

if ( cd "$SHOP_DIR" && APP_ENV=prod MCP_SERVER=1 php bin/console list --raw | grep -q '^debug:mcp ' ); then
  mcp_available=true
  echo "Shopware MCP tooling is available."
else
  echo "Shopware MCP tooling is not available on this version; agent will use source-derived fixtures."
fi

if [ "$mcp_available" = true ]; then
  output=$(cd "$SHOP_DIR" && APP_ENV=prod MCP_SERVER=1 php bin/console integration:create ReproMcp --admin --no-interaction)
  mcp_access_key=$(printf '%s\n' "$output" | sed -n 's/^SHOPWARE_ACCESS_KEY_ID=//p' | tail -n 1)
  mcp_secret_access_key=$(printf '%s\n' "$output" | sed -n 's/^SHOPWARE_SECRET_ACCESS_KEY=//p' | tail -n 1)
  if [ -z "$mcp_access_key" ] || [ -z "$mcp_secret_access_key" ]; then
    echo "::error::Could not parse integration:create output for MCP credentials."
    exit 1
  fi
  echo "::add-mask::$mcp_access_key"
  echo "::add-mask::$mcp_secret_access_key"
fi

if [ "$DEMODATA" = true ]; then
  (
    cd "$SHOP_DIR"
    export APP_ENV=prod
    echo "::group::framework:demodata (bounded) + reindex"
    php bin/console framework:demodata --no-interaction --multiplier=0.1 \
      --products=80 --orders=0 --reviews=0 --promotions=0
    php bin/console dal:refresh:index --no-interaction
    echo "::endgroup::"
  )
fi

(
  cd "$SHOP_DIR"
  export SYMFONY_DAEMON=1
  export SYMFONY_NO_TLS=1
  export SYMFONY_ALLOW_HTTP=1
  export SYMFONY_PORT=8000
  export SYMFONY_ALLOW_ALL_IP=1

  symfony server:start
)

APP_URL="http://localhost:8000"
ready=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$APP_URL/admin" || echo 000)
  if [ "$code" != "000" ]; then
    echo "server responding (HTTP $code) after ${i}s"
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "::error::shop not READY after 60s"; exit 1; }

eval "$(php -r '$u=parse_url(getenv("DATABASE_URL")); printf("DBH=%s DBP=%s DBU=%s DBPW=%s DBN=%s",
  $u["host"]??"127.0.0.1", $u["port"]??3306, $u["user"]??"root", $u["pass"]??"", ltrim($u["path"]??"/","/"));')"
access_key=$(mysql -h"$DBH" -P"$DBP" -u"$DBU" ${DBPW:+-p"$DBPW"} "$DBN" -N -e \
  "SELECT access_key FROM sales_channel WHERE active=1 ORDER BY created_at LIMIT 1;")
echo "::add-mask::$access_key"

{
  echo "app_url=$APP_URL"
  echo "access_key=$access_key"
  echo "mcp_available=$mcp_available"
  echo "mcp_access_key=$mcp_access_key"
  echo "mcp_secret_access_key=$mcp_secret_access_key"
} >> "$GITHUB_OUTPUT"
