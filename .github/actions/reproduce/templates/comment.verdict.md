## AI Report (Reproduction): {{HEADLINE}}

**Quicklinks:** {{QUICKLINKS}}

**Summary:** {{SUMMARY}}
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
{{#AGENT_SUMMARY}}
<details><summary>Agent summary</summary>

{{AGENT_SUMMARY}}

</details>
{{/AGENT_SUMMARY}}
{{#TESTCASE}}
### Test case

<details><summary>repro source ({{TESTCASE_TOOL}})</summary>

```{{TESTCASE_LANG}}
{{TESTCASE}}
```

</details>
{{/TESTCASE}}
{{#FIXTURES}}
### Fixtures

<details><summary>fixtures.json (admin sync payload)</summary>

```json
{{FIXTURES}}
```

</details>
{{/FIXTURES}}
