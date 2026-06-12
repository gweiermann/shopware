#!/usr/bin/env bash
# DEMO (dry_run): emit a canned config-only analysis for one executor. The build step
# turns it into an executable repro bundle.
#
# Env: DEMO_LAYER (http|direct|playwright; default http), ISSUE (req).
set -euo pipefail

: "${ISSUE:?ISSUE is required}"
DEMO_LAYER=${DEMO_LAYER:-http}
echo "::warning::DEMO dry-run ($DEMO_LAYER) — canned analysis, NOT a real analysis."
case "$DEMO_LAYER" in
  http)
    jq -n --argjson issue "$ISSUE" '{
      schema_version:"1", issue:$issue, layer:"store-api", executor:"http", version:"6.6.10.0",
      scenario:["Given a running shop","When POST /store-api/checkout/cart with an empty body","Then a healthy shop returns HTTP 400"],
      build_profile:{admin_build:false,storefront_build:false,theme_build:false},
      derived_from:"DEMO (dry-run)", confidence:1.0, blocked_reason:null
    }' > analysis.json
    ;;
  direct)
    jq -n --argjson issue "$ISSUE" '{
      schema_version:"1", issue:$issue, layer:"service", executor:"direct", version:"6.6.10.0",
      scenario:["Given a provisioned shop","When a PHPUnit integration test resolves a core service","Then the service is available (healthy)"],
      build_profile:{admin_build:false,storefront_build:false,theme_build:false},
      derived_from:"DEMO (dry-run)", confidence:1.0, blocked_reason:null
    }' > analysis.json
    ;;
  playwright)
    jq -n --argjson issue "$ISSUE" '{
      schema_version:"1", issue:$issue, layer:"admin-ui", executor:"playwright", version:"6.6.10.0",
      scenario:["Given a provisioned shop with the admin built","When the admin entry point is opened","Then the page renders (healthy)"],
      build_profile:{admin_build:true,storefront_build:false,theme_build:false},
      derived_from:"DEMO (dry-run)", confidence:1.0, blocked_reason:null
    }' > analysis.json
    ;;
  *) echo "::error::unknown demo_layer '$DEMO_LAYER'"; exit 1 ;;
esac
cat analysis.json
