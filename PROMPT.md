Lets implement white list feature. This will work for all bash commands that are protected in strict mode on. It does not apply to to restrictions in @src/patterns.yaml

1. Add new option Allow and whitelist for a selector
2. If this option selected analize bash command use `pi -p "create reex pattern for this bash command {command}"`
3. If local file is not created create local `.pi/patterns.yaml`
4. Add section strictModeWhiteList and add hwitelisted patters there
5. In strictModePrompt() add whitelist check and skeep prompt for whitelisted patterns
6. When Whitelist is aplied send notification that whitelist pattern was applied and include pattern there,