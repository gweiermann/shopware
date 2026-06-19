#!/usr/bin/env bash
# Render the GitHub comment (-> $OUT, default comment.md) and, when $GITHUB_STEP_SUMMARY is set,
# the job summary. Shared by reproduce + fix-verify; MODE selects leg names + phrasing. The
# `### Evidence` section (inline screenshots + recording links) is appended afterwards by
# embed-evidence.sh — the `#evidence` quicklink anchors to it.
#
# Env: MODE(reproduce|fix-verify, default reproduce), ART(default artifacts), ISSUE,
#      VERDICT, FIX, UNSURE, RUN_URL, DATE(default: today UTC), OUT(default comment.md).
set -euo pipefail

MODE=${MODE:-reproduce}; ART=${ART:-artifacts}; OUT=${OUT:-comment.md}
VERDICT=${VERDICT:-needs_human_review}; FIX=${FIX:-}; UNSURE=${UNSURE:-}; RUN_URL=${RUN_URL:-}
DATE=${DATE:-$(date -u +%Y-%m-%d)}
case "$MODE" in
  reproduce)  A=reported; B=trunk; KIND="Reproduction" ;;
  fix-verify) A=base;     B=head;  KIND="Fix verification" ;;
  *) echo "::error::unknown MODE '$MODE'"; exit 1 ;;
esac
AF="$ART/repro-$A/result.json"; BF="$ART/repro-$B/result.json"
AN="$ART/repro-plan/reproduction-plan.json"
FX="$ART/repro-plan/fixtures.json"
ATTR="$ART/attribution/attribution.json"
LAYER=$(jq -r '.layer // "unknown"' "$AN" 2>/dev/null || echo unknown)
EX=$(jq -r '.executor // "unknown"' "$AN" 2>/dev/null || echo unknown)
have_a=0; [ -f "$AF" ] && have_a=1
have_b=0; [ -f "$BF" ] && have_b=1
as="null"; [ "$have_a" = 1 ] && as=$(jq -r .status "$AF")
bs="null"; [ "$have_b" = 1 ] && bs=$(jq -r .status "$BF")
RV=$(jq -r '.version // "?"' "$([ "$have_a" = 1 ] && echo "$AF" || echo "$AN")" 2>/dev/null || echo '?')
# Human leg labels.
if [ "$MODE" = reproduce ]; then AL="v${RV}"; BL="trunk"; else AL="base"; BL="head"; fi

headline () { case "$VERDICT" in
  live_bug)            echo "Bug reproduced — present on the reported version and on trunk" ;;
  fixed_on_trunk)      echo "Bug reproduced on the reported version — already fixed on trunk" ;;
  regression)          echo "Regression — fine on the reported version, broken on trunk" ;;
  not_reproducible)    echo "Could not reproduce the bug" ;;
  needs_human_review)  echo "Needs human review" ;;
  blocked)             echo "Reproduction blocked (environment)" ;;
  fix_verified)        echo "Fix verified" ;;
  fix_ineffective)     echo "Fix ineffective — symptom still present with the fix" ;;
  test_does_not_guard) echo "Test does not guard the bug" ;;
  introduces_symptom)  echo "Change introduces the symptom" ;;
  *)                   echo "$VERDICT" ;;
esac; }

surface () { case "$LAYER" in
  storefront-ui) echo "the Storefront (browser)" ;;
  admin-ui)      echo "the Admin (browser)" ;;
  store-api)     echo "the Store API" ;;
  admin-api)     echo "the Admin API" ;;
  service)       echo "a service/DAL test" ;;
  *)             echo "$LAYER" ;;
esac; }
executor_label () { case "$EX" in playwright) echo Playwright ;; http) echo HTTP ;; direct) echo PHPUnit ;; *) echo "$EX" ;; esac; }

# Plain-English read of the underlying leg pattern — used by the needs_human_review summary so it
# explains itself: the legs DID find something, it just isn't trusted automatically (reproduce mode).
nhr_underlying () { case "${as}/${bs}" in
  reproduced/reproduced)         echo "Both **${AL}** and **${BL}** reproduced the symptom (alone that would read as a live bug)" ;;
  reproduced/not_reproduced)     echo "**${AL}** reproduced the symptom but **${BL}** did not (alone that would read as fixed on trunk)" ;;
  not_reproduced/reproduced)     echo "**${BL}** reproduced the symptom but **${AL}** did not (alone that would read as a regression)" ;;
  not_reproduced/not_reproduced) echo "Neither **${AL}** nor **${BL}** reproduced the symptom" ;;
  *)                             echo "The legs were indeterminate (**${AL}**: \`${as}\`, **${BL}**: \`${bs}\`)" ;;
esac; }

summary () { local s; s=$(surface); local e; e=$(executor_label)
  case "$VERDICT" in
    live_bug)         echo "Reproduced the reported bug on **v${RV}** and on **trunk** (${DATE}) via ${s} with ${e}." ;;
    fixed_on_trunk)   echo "Reproduced on **v${RV}** but NOT on **trunk** (${DATE}) via ${s} — it appears fixed on trunk.${FIX:+ Likely fix: ${FIX}.}" ;;
    regression)       echo "NOT reproduced on **v${RV}** but reproduced on **trunk** (${DATE}) via ${s} — this looks like a regression introduced after v${RV}." ;;
    not_reproducible) echo "Could not reproduce on **v${RV}** or **trunk** (${DATE}) via ${s} — the generated repro may not faithfully exercise the reported scenario." ;;
    needs_human_review) echo "$(nhr_underlying) — **but the automated verdict is not trusted**${UNSURE:+: ${UNSURE}}. The evidence below is informative; confirm the repro faithfully matches the report before acting." ;;
    blocked)          echo "The reproduction environment did not come up, so nothing was run." ;;
    fix_verified)     echo "The symptom is present on **base** (without the fix) and gone on **head** (with it) — the fix works." ;;
    fix_ineffective)  echo "The symptom still reproduces on **head** (with the fix applied)." ;;
    test_does_not_guard) echo "The repro passes even on **base** (without the fix), so it would not catch a regression." ;;
    introduces_symptom)  echo "**head** reproduces a symptom that **base** does not." ;;
    *)                echo "Verdict: ${VERDICT}." ;;
  esac; }

# Caution blockquote — only for verdicts a human must double-check (the clean ones are covered
# by the summary).
callout () { case "$VERDICT" in
  regression)          echo "> ⚠️ Confirm the reported leg actually exercised the symptom — a missing fixture can fake a regression." ;;
  not_reproducible)    echo "> ℹ️ The symptom was observed on NEITHER version, including the reported (buggy) one — most often the repro doesn't faithfully hit the scenario. Confirm before closing." ;;
  needs_human_review)  echo "> 🟡 Treat as unconfirmed — a human should verify the repro faithfully matches the report before acting." ;;
  fix_ineffective|introduces_symptom) echo "> ❌ The change does not behave as intended — see the result below." ;;
  test_does_not_guard) echo "> ⚠️ Strengthen the test, or the symptom isn't actually being exercised." ;;
esac; }

gloss () { case "$1" in # one-line plain-English read of a leg status
  reproduced)     echo "→ the healthy assertion **failed**, so the symptom is present — **bug reproduced**." ;;
  not_reproduced) echo "→ the healthy assertion **passed** — no symptom on this version (**healthy**)." ;;
  inconclusive)   echo "→ the symptom **could not be judged** here — needs a human look." ;;
  blocked)        echo "→ the environment/seed **failed** — this leg did not run." ;;
  *)              echo "" ;;
esac; }

qval () { case "$1" in (''|*[!0-9]*) printf "'%s'" "$1" ;; (*) printf '%s' "$1" ;; esac; } # quote unless all-digits

# Render each structured check (assertion.checks) as a readable, named assert — one keyword per
# operator (assertEquals / assertContains / assertMatches / assertPresent / assertAbsent /
# assertGreaterThan / assertLessThan), ✅/❌ + the observed value. Fall back to the raw reporter
# line when an executor emits no checks (playwright/direct, or blocked/inconclusive legs).
checks_block () { # <result.json>
  local f="$1"
  if jq -e '.assertion.checks | arrays and length > 0' "$f" >/dev/null 2>&1; then
    echo '```js'
    # One compact JSON object per check (NOT @tsv — empty `expected` fields would collapse under a
    # tab IFS and shift the columns); pull each field with jq so empties are preserved.
    # `require*` keywords = preconditions (failing one → inconclusive); `assert*` = the symptom.
    local c subj role op exp act ok verb call
    while IFS= read -r c; do
      subj=$(jq -r '.subject' <<<"$c"); op=$(jq -r '.op // "equals"' <<<"$c")
      role=$(jq -r '.role // "assert"' <<<"$c")
      exp=$(jq -r '.expected | tostring' <<<"$c"); act=$(jq -r '.actual | tostring' <<<"$c")
      ok=$(jq -r '.ok' <<<"$c")
      [ "$role" = precondition ] && verb="require" || verb="assert"
      case "$op" in
        present)  call="${verb}Present(${subj})" ;;
        absent)   call="${verb}Absent(${subj})" ;;
        contains) call="${verb}Contains(${subj}, $(qval "$exp"))" ;;
        matches)  call="${verb}Matches(${subj}, $(qval "$exp"))" ;;
        gt)       call="${verb}GreaterThan(${subj}, $(qval "$exp"))" ;;
        lt)       call="${verb}LessThan(${subj}, $(qval "$exp"))" ;;
        *)        call="${verb}Equals(${subj}, $(qval "$exp"))" ;;
      esac
      if [ "$ok" = true ]; then echo "${call} // ✅"
      else echo "${call} // ❌ got $(qval "$act")"; fi
    done < <(jq -c '.assertion.checks[]' "$f")
    echo '```'
  else
    local rep; rep=$(jq -r '.evidence.reporter_output // ""' "$f")
    [ -n "$rep" ] && [ "$rep" != null ] && { echo '```'; echo "$rep"; echo '```'; }
  fi
}

emit_result () { # <label> <status> <result.json>
  local label="$1" st="$2" f="$3" br
  br=$(jq -r '.blocked_reason // ""' "$f")
  echo; echo "#### On ${label}: \`${st}\`"; echo
  checks_block "$f"
  echo "$(gloss "$st")"
  if [ -n "$br" ] && [ "$br" != null ]; then echo; echo "> ${br}"; fi
}

# Merge the two legs into one block when they reached the same status (the result is the same on
# both); otherwise show each.
result_section () {
  if   [ "$have_a" = 1 ] && [ "$have_b" = 1 ] && [ "$as" = "$bs" ]; then emit_result "${AL} & ${BL}" "$as" "$AF"
  elif [ "$have_a" = 1 ] && [ "$have_b" = 1 ]; then emit_result "$AL" "$as" "$AF"; emit_result "$BL" "$bs" "$BF"
  elif [ "$have_a" = 1 ]; then emit_result "$AL" "$as" "$AF"
  elif [ "$have_b" = 1 ]; then emit_result "$BL" "$bs" "$BF"
  fi
}

# Test case (the generated spec, authored once — show one). Source from whichever leg has it.
SF="$AF"; [ "$have_a" = 1 ] || SF="$BF"
SCRIPT=""; LANG=sh
if [ -f "$SF" ]; then SCRIPT=$(jq -r '.evidence.script // ""' "$SF"); LANG=$(jq -r '.evidence.script_lang // "sh"' "$SF"); fi
has_script=0; [ -n "$SCRIPT" ] && has_script=1
has_fixtures=0; [ -f "$FX" ] && has_fixtures=1

{
  echo "## AI Report (${KIND}): $(headline)"
  echo
  # Quicklinks — Screenshots/Video anchor to the Evidence section (playwright only); Test case /
  # Fixtures anchor to the collapsibles below.
  ql="[Agent run](${RUN_URL})"
  [ "$EX" = playwright ] && ql="${ql} · [Screenshots & video](#evidence)"
  [ "$has_script" = 1 ]  && ql="${ql} · [Test case](#test-case)"
  [ "$has_fixtures" = 1 ] && ql="${ql} · [Fixtures](#fixtures)"
  echo "**Quicklinks:** ${ql}"
  echo
  echo "**Summary:** $(summary)"
  c=$(callout); [ -n "$c" ] && { echo; echo "$c"; }
  if [ -f "$ATTR" ]; then
    echo; echo "**Likely $(jq -r .kind "$ATTR") commit:** \`$(jq -r .likely_commit "$ATTR")\` — $(jq -r .reasoning "$ATTR")"
  fi
  # Scenario above the result, shown directly (no spoiler) — it's the context for reading the
  # verdict. One step per bullet, Gherkin keyword bolded — NOT an ordered list (the "1." fights
  # the Given/When/Then and collapses the steps into a wall of text). No \b: BSD sed lacks it.
  if jq -e '.scenario | arrays and length > 0' "$AN" >/dev/null 2>&1; then
    echo; echo "### Scenario"; echo
    jq -r '.scenario[]' "$AN" | sed -E -e 's/^(Given|When|Then|And|But) /**\1** /' -e 's/^/- /'
  fi
  echo
  echo "### Result"
  result_section
  # Placeholder: embed-evidence.sh inserts the `### Evidence` (screenshots + recording) block
  # HERE — right under the verdict, above the collapsible details. Invisible if it never runs.
  echo; echo "<!-- EVIDENCE -->"
  if [ "$has_script" = 1 ]; then
    # Label by the TOOL (obvious: curl / Playwright / PHPUnit), not the raw fence language.
    case "$EX" in http) tctool=curl ;; playwright) tctool=Playwright ;; direct) tctool=PHPUnit ;; *) tctool="$LANG" ;; esac
    echo; echo "### Test case"; echo "<details><summary>repro source (${tctool})</summary>"; echo
    echo "\`\`\`${LANG}"; printf '%s\n' "$SCRIPT"; echo '```'; echo; echo "</details>"
  fi
  if [ "$has_fixtures" = 1 ]; then
    echo; echo "### Fixtures"; echo "<details><summary>fixtures.json (admin sync payload)</summary>"; echo
    echo '```json'; cat "$FX"; echo '```'; echo; echo "</details>"
  fi
} > "$OUT"

# Deterministic secret redaction — the comment is public and parts of it (summary, scripts,
# reporter output, fixtures) originate from agent output over untrusted input. This deterministic
# pass is the belt that doesn't rely on the agent having redacted anything.
# NB: no \b — BSD sed lacks it and silent non-redaction is worse than over-redaction.
sed -E -i.bak \
  -e 's/sk-ant-[A-Za-z0-9_-]{8,}/[REDACTED_KEY]/g' \
  -e 's/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/[REDACTED_TOKEN]/g' \
  -e 's/github_pat_[A-Za-z0-9_]{20,}/[REDACTED_TOKEN]/g' \
  -e 's/AKIA[0-9A-Z]{16}/[REDACTED_AWS_KEY]/g' \
  -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._~+\/-]{16,}=*/\1[REDACTED]/g' \
  "$OUT" && rm -f "$OUT.bak"

[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$OUT" >> "$GITHUB_STEP_SUMMARY"
cat "$OUT"
