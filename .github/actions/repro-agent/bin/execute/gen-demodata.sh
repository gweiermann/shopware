#!/usr/bin/env bash
# Generate a bounded demo dataset on the live shop. INTERNAL — invoked by verify-reproduction.sh
# when reproduction-plan.json sets fixtures.demodata=true, not by the agent directly. Mirrors the
# provision action's bounded generator (~15s) exactly, so the trunk leg (which provisions demodata
# from the plan) produces a comparable dataset. Demodata is RANDOM per instance.
#
# Env: SHOP_DIR (default shop).
set -euo pipefail
cd "${SHOP_DIR:-shop}"
echo "::group::framework:demodata (bounded) + reindex"
APP_ENV=prod php bin/console framework:demodata --no-interaction --multiplier=0.1 \
  --products=80 --orders=0 --reviews=0 --promotions=0
APP_ENV=prod php bin/console dal:refresh:index --no-interaction
echo "::endgroup::"
echo "== gen-demodata: done =="
