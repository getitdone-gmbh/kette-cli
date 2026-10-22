# Changelog

## 0.6.2
- The agent pack plugin `ui-gesetze` is now `ui-laws` (skills `ui-laws`, `interaction-principles`, `a11y-standards`). Community and Enterprise install `ui-laws@kette`, and `kette update`, `kette add` and `kette login` remove `ui-gesetze@kette` once the bundle has `ui-laws`.
- `kette rules` finds the German topic names of older rulebooks (`kette rules lesbarkeit`) through `rules/aliases.json`, and a typo of an old name suggests the new topic.
- Arguments named like `toString` or `constructor` are read as plain arguments: `kette rules toString` reports an unknown topic.
- Update the CLI before or with this rulebook. CLI 0.6.1 and older do not know `ui-laws`, keep `ui-gesetze@kette` and warn that the bundle lacks it.
- German rule topic names (`kette rules lesbarkeit`) need CLI 0.6.2 or newer.
- CLI 0.5.x: update the CLI to see the `preview` platform warning again.
