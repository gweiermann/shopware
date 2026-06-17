#!/usr/bin/env bash
# Build the Storefront JS + theme for the live shop (the lean provision skipped it). INTERNAL —
# invoked by verify-reproduction.sh when reproduction-plan.json sets build_profile.storefront_build
# =true, not by the agent directly.
#
# BUG FIX: the build assumes the storefront node_modules exist; install them first on a lean shop.
#
# Env: SHOP_DIR (default shop).
set -euo pipefail
cd "${SHOP_DIR:-shop}"
SF_APP=src/Storefront/Resources/app/storefront
echo "::group::install storefront deps + build + theme"
if [ -d "$SF_APP" ]; then
  npm --prefix "$SF_APP" ci || npm --prefix "$SF_APP" install
fi
composer run build:js:storefront
APP_ENV=prod php bin/console assets:install
APP_ENV=prod php bin/console theme:compile
echo "::endgroup::"
echo "== build-storefront: done =="
