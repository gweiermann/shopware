#!/usr/bin/env bash
# Bug #16511: out-of-range store-api product-listing returns 200 instead of 404.
# Fix #16575's regression test asserts 404 + PRODUCT__LISTING_PAGE_OUT_OF_RANGE.
#
# A correct Analyze derives config only: store-api/http, reported version 6.7.9.0,
# no asset build, scenario mentioning product-listing and the out-of-range page,
# and the linked regression source.
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
load_output
check_schema_analysis

check "layer-store-api"      '.layer == "store-api"'
check "executor-http"        '.executor == "http"'
check "version-reported"     '.version == "6.7.9.0"'
check "scenario-listing"     '(.scenario // [] | join(" ")) | test("product-listing|listing"; "i")'
check "scenario-out-of-range" '(.scenario // [] | join(" ")) | test("p=99|out.of.range|OUT_OF_RANGE|404"; "i")'
check "no-asset-build"       '[.build_profile.admin_build, .build_profile.storefront_build, .build_profile.theme_build] | all(. == false)'
check "derived-from-test"    '(.derived_from // "") | test("16575|ProductListing|OUT_OF_RANGE")'

emit_result
