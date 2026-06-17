#!/usr/bin/env bash
# On-the-fly demodata for the live REPORTED instance (the gh-aw flow provisions it lean, so the
# agent opts into demodata only if its repro needs a realistic, pre-populated, indexed catalog).
# Mirrors the provision action's bounded generator (~15s) exactly, so the trunk leg — which
# regenerates from reproduction-plan.json — produces a comparable dataset.
#
# IMPORTANT: if you run this, set fixtures.demodata: true in reproduction-plan.json so the trunk
# leg provisions WITH demodata too. Demodata is RANDOM per instance — anchor your repro on YOUR
# seeded delta or a structural role, never a generated item.
#
# Env: SHOP_DIR (default shop).
set -euo pipefail
cd "${SHOP_DIR:-shop}"
echo "::group::framework:demodata (bounded) + reindex"
APP_ENV=prod php bin/console framework:demodata --no-interaction --multiplier=0.1 \
  --products=80 --orders=0 --reviews=0 --promotions=0
APP_ENV=prod php bin/console dal:refresh:index --no-interaction
echo "::endgroup::"
echo "== gen-demodata: done — remember to set fixtures.demodata:true in reproduction-plan.json =="
