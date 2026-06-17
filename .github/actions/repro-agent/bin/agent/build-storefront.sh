#!/usr/bin/env bash
# On-the-fly Storefront build (+ theme compile) for the live REPORTED instance. The gh-aw flow
# provisions lean (no JS build), so the agent runs this only if its repro needs the Storefront
# (a storefront-ui / playwright bug).
#
# IMPORTANT: if you run this, set build_profile.storefront_build = true (and theme_build = true)
# in reproduction-plan.json so the trunk leg builds the Storefront too.
#
# Env: SHOP_DIR (default shop).
set -euo pipefail
cd "${SHOP_DIR:-shop}"
echo "::group::build storefront + theme"
composer run build:js:storefront
APP_ENV=prod php bin/console assets:install
APP_ENV=prod php bin/console theme:compile
echo "::endgroup::"
echo "== build-storefront: done — remember to set build_profile.storefront_build/theme_build:true in reproduction-plan.json =="
