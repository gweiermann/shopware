# Playwright specs — `repro.spec.ts`

For any rendered/visual/interaction symptom. The spec asserts the **healthy** behaviour: it fails on
the buggy version (⇒ reproduced) and passes when healthy (⇒ not_reproduced).

## The rules `repro validate` enforces

- **Import only `@playwright/test`.**
- **Exactly one awaited `expect(...)`** — the final healthy-symptom assertion. Everything before it
  is setup, expressed as waits/actions, not asserts.
- **No API setup from the spec** — no `fetch`, `page.request.*`, or `page.evaluate(fetch…)`. Static
  state goes in `fixtures.json` so both legs seed identically; create runtime state only through the
  owning UI flow.
- **No non-local URLs** — navigate relative to `baseURL` (`page.goto('/detail/…')`).

## Preconditions gate the symptom

Setup steps must prove the scenario is exercisable, and **throw `PRECONDITION_NOT_FOUND: <what>`**
when it isn't — so a missing precondition becomes `inconclusive`, not a fake pass/fail. Use bounded
waits, not instant `count()` samples (SPA/Admin pages are still loading):

```ts
await page.goto('/detail/<seeded-id>');
await page.locator('.product-detail-buy').waitFor({ state: 'visible', timeout: 15000 })
  .catch(() => { throw new Error('PRECONDITION_NOT_FOUND: buy widget not on the product page'); });

await expect(page.locator('.product-detail-price')).toHaveText('19,99 €'); // the one healthy assertion
```

Keep each precondition its own gate so a failure names the missing state.

## Auth — the harness owns it

- **admin-ui:** the harness logs in and hands the spec an authenticated session. Navigate straight to
  `/admin#/sw/...`; do **not** author login steps. (A login/bootstrap bug is the exception — then
  clear state, drive `/admin#/login` yourself, and assert the shell becomes usable.)
- **storefront-ui:** the harness pre-accepts cookie consent by default. Don't clear cookies unless
  the bug is the consent flow (`browser_state.auto_cookie_consent: false`).

## Optional video evidence

A screenshot + Playwright trace is captured for every run. If the bug is inherently about motion or a
multi-step interaction (an animation, a drag, a flow that a still frame can't convey), set
`"record_video": true` in `reproduction-plan.json` — the trunk leg then records a `.webm` and the
comment links it. Leave it off (the default) otherwise; a screenshot is enough for most bugs.

Use `repro check` and `playwright-cli` to nail selectors and timing before committing the spec; a
final `repro try` gives a non-authoritative preview and points you at the screenshot to review.
