The reproduce pipeline returned verdict "{{VERDICT}}" for issue #{{ISSUE}}. Read repro-plan.json
for the reported version and the implicated code paths/symptom. Inspect
`git log v<reported-version>..trunk` restricted to those paths and find the single commit that
most likely {{ACTION}} the symptom (the one whose diff touches the asserted behaviour). Write
ONLY this JSON to attribution.json — no prose, no fence:
{"schema_version":"1","kind":"{{KIND}}","likely_commit":"<sha>","pr":"<#-or-null>","reasoning":"<1-2 sentences>","confidence":0.0}
