## AI Report (Reproduction): {{HEADLINE}}

### Summary

| | |
|---|---|
| **Verdict** | {{VERDICT_BADGE}} |
| **Reported** `{{RV}}` | {{REPORTED_STATUS}} |
| **Trunk** | {{TRUNK_STATUS}} |
| **Surface** | {{SURFACE_EXEC}} |
| **Confidence** | {{CONFIDENCE}} |
| **Checked** | {{DATE}} |
{{#FIX}}
| **Likely fix** | {{FIX}} |
{{/FIX}}
{{#UNSURE}}
| **Not trusted** | {{UNSURE}} |
{{/UNSURE}}
{{#CALLOUT}}

{{CALLOUT}}
{{/CALLOUT}}
{{#EDITS}}

> ⚠️ The agent changed files **outside its reproduction bundle**. The verdict was still produced by re-running the bundle deterministically from an immutable copy of the tooling, so it is unaffected — but review the changes below if you want to be sure.

<details><summary>Files changed outside the bundle</summary>

```
{{EDITS}}
```

</details>
{{/EDITS}}
{{#SCENARIO}}
### Scenario

{{SCENARIO}}
{{/SCENARIO}}
### Result
{{#AGENT_EXPLANATION}}
#### Agent Explanation

{{AGENT_EXPLANATION}}
{{/AGENT_EXPLANATION}}
{{RESULT}}

<!-- EVIDENCE -->
{{ARTIFACTS_HEADING}}
{{#AGENT_SUMMARY}}
<details><summary>🕵️ How the agent reproduced it — its own write-up</summary>

{{AGENT_SUMMARY}}

</details>
{{/AGENT_SUMMARY}}
{{#TESTCASE}}
<details><summary>🧪 Reproduction test — the exact {{TESTCASE_TOOL}} code that produced this verdict</summary>

```{{TESTCASE_LANG}}
{{TESTCASE}}
```

</details>
{{/TESTCASE}}
{{#FIXTURES}}
<details><summary>🌱 Seed data — entities created on the shop before the test (fixtures.json)</summary>

```json
{{FIXTURES}}
```

</details>
{{/FIXTURES}}

<sub>🔁 <a href="{{RUN_URL}}">Reproduce run</a></sub>
