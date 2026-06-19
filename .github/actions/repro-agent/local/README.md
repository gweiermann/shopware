# Local repro-agent eval harness

This folder is a local-only harness for testing `.github/actions/repro-agent` before spending GitHub
Actions minutes. It keeps the gh-aw workflow as the source of truth and only wraps it with local
preparation, cleanup, simulated-agent execution, and stricter evidence review.

## Loop

1. Prepare issue context and `build-context.md`.
2. Reset generated artifacts and the Shopware instance.
3. Run a simulated agent with the same prompt and a configurable `maxTurns`.
4. Run `bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh`.
5. Verify the produced bundle and Playwright evidence more strictly than CI.
6. Patch prompts only with generalized rules, then rerun the eval set.

Issue #30 is the first eval case, not the prompt target. Prompt changes must stay generic enough for
other visual, HTTP, and direct reproductions.

## Model policy

Use `gpt-5.5` with `reasoning.effort: "low"` for the simulated build agent. Use `gpt-5.5` with
`medium` or `high` reasoning for the orchestrator/evidence reviewer when screenshots need visual
inspection.

## Commands

```bash
# Remove generated repro files from the repo root.
bash .github/actions/repro-agent/local/scripts/reset-instance.sh --artifacts-only

# Create local issue context for issue 30 using gh, then assemble build-context.md.
ISSUE=30 REPO=gweiermann/shopware bash .github/actions/repro-agent/local/scripts/prepare-run.sh

# Static smoke check of generated or cookbook bundle contracts.
node .github/actions/repro-agent/local/scripts/verify-output.mjs --root .github/actions/repro-agent/references/cookbook/cms-product-slider

# Simulated agent entrypoint. Requires OPENAI_API_KEY when not using --dry-run.
node .github/actions/repro-agent/local/scripts/run-agent.mjs --issue 30 --max-turns 12 --dry-run
```

## Acceptance gates

For a visual CMS product-slider issue, the verifier rejects a bundle unless:

- `reproduction-plan.json.executor` is `playwright`.
- `fixtures.json` nests CMS entities as `cms_page.sections.blocks.slots`.
- the spec navigates by a technical route such as `/landingPage/<id>`.
- the precondition throws `PRECONDITION_NOT_FOUND` when the seeded rendered entity is absent.
- there is exactly one `await expect(...)`, and it is the healthy symptom assertion.
- Playwright evidence exists for completed runs.

For issue #30 specifically, the orchestrator must also inspect screenshots and confirm that the
claimed evidence really shows a rendered storefront product slider with the relevant product/variant
state. A blank page, an admin page, a generic product listing, or a report-only artifact is not
accepted as visual proof.
