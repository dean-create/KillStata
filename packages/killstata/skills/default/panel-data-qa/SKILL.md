---
name: panel-data-qa
description: Use this to validate entity-time structure, duplicate keys, sample continuity, and panel integrity before panel or causal estimation.
---

# Panel Data QA

Use this skill when the dataset has entity and time structure or the analysis depends on panel logic.

## Checklist

- Confirm the entity identifier and time identifier explicitly.
- Check for duplicate entity-time keys.
- Check whether treatment timing is coherent for treated units.
- Check panel balance, missing years, and suspicious one-period entities.
- Surface whether clustering should be at the entity level or another level.

## Tool path

1. Use `data_import` with `action="qa"`.
2. Use `data_import` with `action="describe"` if the panel structure needs a quick profile.
3. Do not move to `panel_fe_regression`, DID, or event study until panel QA is non-blocking.
