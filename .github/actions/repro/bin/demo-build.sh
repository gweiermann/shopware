#!/usr/bin/env bash
# DEMO (dry_run): turn the canned config-only analysis into an executable repro bundle.
#
# Env: DEMO_LAYER (http|direct|playwright; default http), DEMO_DIR.
set -euo pipefail

DEMO_LAYER=${DEMO_LAYER:-http}
DEMO_DIR=${DEMO_DIR:-.github/actions/repro/demo}

[ -f analysis.json ] || { echo "::error::analysis.json missing"; exit 1; }
echo "::warning::DEMO dry-run ($DEMO_LAYER) — canned repro bundle, NOT a real build."

case "$DEMO_LAYER" in
  http)
    jq '. + {
      fixtures:{demodata:false,sync_payload_path:"fixtures.json"},
      request:{method:"POST",path:"/store-api/checkout/cart",headers:{"Content-Type":"application/json"},body:"{}"},
      assertion:{kind:"http_status",expect:"400",field:null,locator:"/store-api/checkout/cart"}
    }' analysis.json > repro-plan.json
    ;;
  direct)
    jq '. + {
      fixtures:{demodata:false,sync_payload_path:"fixtures.json"},
      script_path:"ReproTest.php",
      assertion:{kind:"phpunit",expect:"test passes (healthy)"}
    }' analysis.json > repro-plan.json
    cp "$DEMO_DIR/ReproTest.php" ReproTest.php
    ;;
  playwright)
    jq '. + {
      fixtures:{demodata:false,sync_payload_path:"fixtures.json"},
      script_path:"repro.spec.ts",
      assertion:{kind:"ui_state",expect:"spec passes (healthy)"}
    }' analysis.json > repro-plan.json
    cp "$DEMO_DIR/repro.spec.ts" repro.spec.ts
    ;;
  *) echo "::error::unknown demo_layer '$DEMO_LAYER'"; exit 1 ;;
esac

cat repro-plan.json
