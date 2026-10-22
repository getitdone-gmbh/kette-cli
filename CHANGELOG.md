# Changelog

## 0.6.2
- The agent pack plugin `ui-gesetze` is now `ui-laws` (skills `ui-laws`, `interaction-principles`, `a11y-standards`). Community installs `ui-laws@kette`, and `kette update` and `kette add` remove `ui-gesetze@kette` once the bundle has `ui-laws`. Enterprise does not install it (the skills ship in `design-review-pack` and `design-system-agents`): `kette login` removes `ui-laws@kette` and `ui-gesetze@kette`, `kette logout` installs `ui-laws@kette` again.
- `kette rules` finds the German topic names of older rulebooks (`kette rules lesbarkeit`) through `rules/aliases.json`, and a typo of an old name suggests the new topic.
- New stack `react-spa` (React + Vite single page app, Enterprise, app folder `apps/spa`): in the stack question, `--stack react-spa`, and detected from `vite` plus `react` without Next.js or Expo. Platform templates skip it with a hint.
- Community: `kette rules <profile>` for any stack or platform profile the rulebook names (e.g. `react-spa`) says it is an Enterprise profile and points to `kette login`. The Community bundle now carries `profiles/stack/index.json` for that.
- `.kette/README.md` lists the core topics of the installed rulebook (now with `comments`).
- `kette update` on Node 23 no longer stops with "Path is a directory" when it moves the active bundle link.
- Arguments named like `toString` or `constructor` are read as plain arguments: `kette rules toString` reports an unknown topic.
- Update the CLI before or with this rulebook. CLI 0.6.1 and older do not know `ui-laws`, keep `ui-gesetze@kette` and warn that the bundle lacks it. If that already happened, `kette update` with CLI 0.6.2 repairs the plugins even when the bundle is up to date, and `kette doctor` names that step.
- German rule topic names (`kette rules lesbarkeit`) need CLI 0.6.2 or newer.
- CLI 0.5.x: update the CLI to see the `preview` platform warning again.
