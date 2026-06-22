# Local repro-agent eval harness

This folder is a local-only harness for testing `.github/actions/repro-agent` before spending GitHub
Actions minutes. It keeps the gh-aw workflow as the source of truth and only wraps it with local
preparation, cleanup, simulated-agent execution, and stricter evidence review.

## Loop

1. Prepare issue context and `build-context.md`.
2. Reset generated artifacts and the Shopware instance.
3. Run a simulated agent with the same prompt.
4. Run `bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh`.
5. Verify the produced bundle and Playwright evidence more strictly than CI.
6. Patch prompts only with generalized rules, then rerun the eval set.

Single issues can be used as smoke tests, but prompt changes must stay generic enough for other
visual, HTTP, and direct reproductions.

## Model policy

Use `gpt-5.4` with `reasoning.effort: "low"` for the simulated build agent. Use `gpt-5.4` with
`medium` or `high` reasoning for the orchestrator/evidence reviewer when screenshots need visual
inspection.

## Commands

```bash
# Remove generated repro files from the repo root.
bash .github/actions/repro-agent/local/scripts/reset-instance.sh --artifacts-only

# Create local issue context for an issue using gh, then assemble build-context.md.
ISSUE=30 REPO=gweiermann/shopware bash .github/actions/repro-agent/local/scripts/prepare-run.sh

# Static smoke check of the generated bundle contract.
node .github/actions/repro-agent/local/scripts/verify-output.mjs

# Probe a live rendered route with the same Admin login harness used by repro specs.
APP_URL=http://localhost:18080 ADMIN_USER=admin ADMIN_PASS=shopware \
  bash .github/actions/repro-agent/bin/agent/probe-ui.sh '/admin#/sw/category/index' 375x812

# Simulated agent entrypoint. Uses the Codex CLI auth/session; no raw OPENAI_API_KEY is required.
node .github/actions/repro-agent/local/scripts/run-agent.mjs --issue 30 --dry-run
node .github/actions/repro-agent/local/scripts/run-agent.mjs --issue 30
```

## Acceptance gates

For visual Playwright issues, the verifier rejects a bundle unless:

- `reproduction-plan.json.executor` is `playwright`.
- seeded/static state is represented in `fixtures.json` using source-derived DAL shape.
- the spec reaches seeded content through a stable route or source-backed navigation path.
- preconditions throw `PRECONDITION_NOT_FOUND` when issue-specific setup is absent.
- there is exactly one `await expect(...)`, and it is the healthy symptom assertion.
- Playwright evidence exists for completed runs.

The orchestrator must inspect screenshots and confirm that claimed evidence really shows the
issue-specific state. A blank page, the wrong surface, generic chrome, or a report-only artifact is
not accepted as visual proof.
