#!/usr/bin/env bash
# Build the Administration JS for the live shop (the lean provision skipped it). INTERNAL — invoked
# by verify-reproduction.sh when reproduction-plan.json sets build_profile.admin_build=true, not by
# the agent directly.
#
# BUG FIX: `composer run build:js:admin` runs `npm run build` but does NOT install the admin's
# node_modules first, so on a lean install the build fails. Install deps (ci, fall back to install)
# in the admin app dir before building.
#
# Env: SHOP_DIR (default shop).
set -euo pipefail
cd "${SHOP_DIR:-shop}"
ADMIN_APP=src/Administration/Resources/app/administration
echo "::group::install administration deps + build"
if [ -d "$ADMIN_APP" ]; then
  npm --prefix "$ADMIN_APP" ci || npm --prefix "$ADMIN_APP" install
fi
composer run build:js:admin
APP_ENV=prod php bin/console assets:install
echo "::endgroup::"
echo "== build-admin: done =="
