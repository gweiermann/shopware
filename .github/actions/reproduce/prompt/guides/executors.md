# Choosing an executor: http & direct

Pick the cheapest executor that faithfully exercises the symptom:

- **playwright** — anything rendered: visual, layout, interaction, missing/wrong UI text, browser
  state. A *visual* issue must use this. See [playwright.md](playwright.md).
- **http** — Store API / Admin API / Sync API JSON behaviour, no rendering involved.
- **direct** — internal PHP service/DAL behaviour that can't fire faithfully through the API or UI
  (license-gated, heavy domain setup). A PHPUnit integration test.

## http

Requests and assertions live in `reproduction-plan.json` (see [plan.md](plan.md)). The executor owns
auth by surface — `/api/*` gets an admin Bearer token, `/store-api/*` gets the sales-channel key — so
drop any auth headers of your own. Multi-step: use `requests: [...]`; `sw-context-token` is captured
and carried forward, and a non-final setup request that isn't 2xx makes the leg `blocked`.

Assertion fields are jq filters on the final response. Ops: `equals` (default), `contains`,
`matches`, `present`, `absent`, `gt`, `lt`. `expect` is the **healthy** value. Mark setup checks
`"role": "precondition"` and the symptom `"role": "assert"`.

Status: all assertions pass ⇒ `not_reproduced`; a symptom assert fails ⇒ `reproduced`. Guards that
force `inconclusive` instead of a bogus verdict: a failed precondition, an unasserted 401/403, or an
unreadable field on a non-2xx response.

## direct — `ReproTest.php`

A PHPUnit integration test under `Shopware\Tests\Integration\` asserting the healthy behaviour:

```php
<?php declare(strict_types=1);
namespace Shopware\Tests\Integration\Repro;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Framework\Test\TestCaseBase\KernelLifecycleManager;
// use IntegrationTestBehaviour / KernelTestBehaviour as the service under test needs.

class ReproTest extends TestCase
{
    public function testHealthy(): void
    {
        // arrange via the container/DAL, act, then assert the FIXED behaviour.
        static::assertSame(19.99, $result->getUnitPrice());
    }
}
```

Status: `OK` ⇒ `not_reproduced`; `FAILURES!` ⇒ `reproduced`; `ERRORS!`/fatal ⇒ `inconclusive`
(cross-version mismatch) — **unless** the symptom is an exception: set `assertion.symptom_pattern`
to a regex, and a matching error counts as `reproduced` (DAL writes throw during synchronous
indexing, so the symptom often escapes a try/catch around a later call).
