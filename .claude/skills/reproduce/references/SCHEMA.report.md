# Contract: `repro-output.json` (Report) + the verdict map

Reference for the deterministic verdict/report steps (`bin/verdict.sh`, `bin/report.sh`).
NOT produced by an agent — neither Analyze nor Build Repro loads this file.

## Merged Report (`repro-output.json`)

```json
{
    "schema_version": "1",
    "issue": 16638,
    "verdict": "live_bug | fixed_on_trunk | regression | not_reproducible | blocked | needs_human_review",
    "fix_candidate": "PR#16575",
    "layer": "store-api",
    "results": { "reported": { "...": "result.json" }, "trunk": { "...": "result.json" } },
    "summary": "1-3 sentences naming the symptom and surface.",
    "label": "ci:reproduced | ci:not-reproduced | ci:fixed-on-trunk | ci:repro-blocked",
    "requires_human": false
}
```

Verdict map (first match wins):

| reported | trunk | verdict |
| --- | --- | --- |
| any `blocked` | - | `blocked` |
| plan `blocked_reason` set or `0.4 <= confidence < 0.7` | - | `needs_human_review` |
| any `inconclusive` | - | `needs_human_review` |
| `reproduced` | `reproduced` | `live_bug` |
| `reproduced` | `not_reproduced` | `fixed_on_trunk` |
| `not_reproduced` | `reproduced` | `regression` |
| `not_reproduced` | `not_reproduced` | `not_reproducible` |
| anything else | - | `needs_human_review` |

When targets collapse to one leg, the missing leg is `null`; a single-leg run can
only yield `live_bug`, `not_reproducible`, or `needs_human_review`.
