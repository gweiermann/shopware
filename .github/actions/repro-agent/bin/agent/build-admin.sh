#!/usr/bin/env bash
# On-the-fly Administration build for the live REPORTED instance. The gh-aw flow provisions lean
# (no JS build), so the agent runs this only if its repro needs the Admin UI (an admin-ui /
# playwright bug).
#
# IMPORTANT: if you run this, set build_profile.admin_build = true in reproduction-plan.json so the
# trunk leg builds the Admin too (otherwise the legs are not comparable).
#
# Env: SHOP_DIR (default shop).
set -euo pipefail
cd "${SHOP_DIR:-shop}"
echo "::group::build administration"
composer run build:js:admin
APP_ENV=prod php bin/console assets:install
echo "::endgroup::"
echo "== build-admin: done — remember to set build_profile.admin_build:true in reproduction-plan.json =="
