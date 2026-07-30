# Contributing

## Working on the plugin

Install into your own Hermes profile and edit in place:

```bash
./install.sh
```

That copies `desktop-plugins/hermes-yt-plugin/` into
`~/.hermes/desktop-plugins/hermes-yt-plugin/`. Hermes fs-watches that directory,
so a re-run of `install.sh` reloads the plugin on the next change tick — no
restart, nothing to enable.

Set `HERMES_HOME` to install into a different profile.

## Before opening a PR

```bash
node --check desktop-plugins/hermes-yt-plugin/plugin.js
bash -n install.sh
shellcheck install.sh
node .github/scripts/check-imports.mjs
node .github/scripts/check-updater.mjs
```

CI runs exactly these five. `main` is protected, so everything lands through a
pull request.

## Publishing a release

Before tagging a release, update `VERSION` near the top of
`desktop-plugins/hermes-yt-plugin/plugin.js`. It must match the release tag
without the leading `v`; for example, tag `v0.3.0` must contain
`const VERSION = '0.3.0'`.

The in-app updater reads GitHub's latest published release, downloads the
plugin file at that exact tag, and rejects it when the embedded version differs.
Draft and prerelease versions are therefore not offered automatically.

## Two constraints that will bite you

**Never write the word `from` followed by a quoted token anywhere in
`plugin.js` — not even in a comment.** Hermes resolves a plugin's imports by
regex-scanning raw source with no comment awareness, so prose that looks like a
specifier is read as a bare import and the plugin is refused at load time.
`check-imports.mjs` runs the loader's own regex to catch this.

**Imports are limited to `@hermes/plugin-sdk`, `react`, and
`react/jsx-runtime`.** There is no build step; the plugin ships as uncompiled
ESM and uses `react/jsx-runtime` directly rather than JSX. Styles stay inline
because Tailwind does not scan runtime plugin directories.

## Scope

This plugin runs YouTube's own player in a `<webview>` and deliberately does not
touch media streams or block ads. PRs that add stream extraction or ad blocking
will be declined.
