# Development guide

## Setup and checks

Use Node.js 24 (see `.nvmrc`) and the committed lockfile.

```sh
npm ci
npm run test:unit                       # editor-independent parser tests
npm test                                # integration tests on current stable VS Code
npm test -- --code-version 1.137.0      # integration tests on the minimum supported VS Code
npm run package:vsix                    # build latex-suite-vscode-<version>.vsix (does not publish)
npm run check:package                   # verify the archive contents
npm run test:vsix                       # install the archive into a clean profile and smoke-test it
npm run test:trust                      # same, in Restricted Mode
npm run benchmark                       # parser timing (diagnostic only)
npm audit
```

Use `npm run watch` while developing, or press F5 to launch an Extension
Development Host.

- `npm test` type-checks, lints, bundles, and runs three test hosts: editor
  behavior, multi-root configuration, and controller lifecycle. Select one with
  `--label editor`, `--label configuration`, or `--label lifecycle`.
- On headless Linux, wrap test commands in `xvfb-run -a`.
- `test:vsix` and `test:trust` default to current stable; set `VSCODE_VERSION`
  to test another release. If they fail with `listen EINVAL` on a `.sock` path,
  `TMPDIR` is too long for a Unix socket; rerun with a short `TMPDIR` such as
  `/tmp`.
- `check:package` fails if the archive contains anything beyond the bundle,
  icon, manifest, README, and license files, or if a new runtime dependency is
  bundled without its license notice. Repackage after every edit.

CI (`.github/workflows/ci.yml`) runs the unit, integration, and package checks
on Linux, Windows, and macOS against the minimum and stable VS Code versions,
plus the installed and Restricted Mode smoke tests on Linux. It never publishes.

## Engineering rules

| Area | Rule |
| --- | --- |
| Activation | Activate after startup so configured file extensions work with any language ID. Gate editing and keybindings by `latexSuite.fileExtensions`. Do not evaluate custom snippets or read files during activation. |
| Lifecycle | Register everything through disposables. Cancel pending editor waits on shutdown and drop stale operations after edits, selection or configuration changes, or disposal. |
| Workspace Trust | Run custom JavaScript only in trusted workspaces. Keep the four executable-source settings restricted, keep bundled defaults in Restricted Mode, and invalidate caches when trust changes. |
| Files and configuration | Read through `workspace.fs` and build paths with `Uri.joinPath`; use `fsPath` only for `file:` URIs. Resolve configuration per document and relative paths per workspace folder. |
| Editing | Scope keybindings with context keys. Preserve native completion, snippet navigation, Tab focus mode, and undo. |
| Packaging | Bundle with esbuild, externalize `vscode`, and ship only the runtime, icon, README, and licenses. |
| Upstream | Record intentional differences in `UPSTREAM.md`. Port fixes with independently written expected outputs; never regenerate expectations from the code. |

See the [VS Code extension API docs](https://code.visualstudio.com/api) when
raising `engines.vscode` or adding capabilities. Browser-only hosts such as
vscode.dev are not supported.

## Performance

Cursor movement reuses one parsed document revision; each edit re-parses the
document. Unanchored regex triggers inspect at most the last 8,192 UTF-16 code
units before the cursor. Custom JavaScript and regular expressions run
synchronously in the extension host, so very large documents or expensive
custom snippets can add typing latency.

## Releasing

Publication is manual. Tag pushes run release validation and the full CI matrix;
GitHub Actions never authenticates to or publishes to Marketplace.

1. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`).
2. Make sure CI is green on the exact commit being released. Validate the planned
   tag with `RELEASE_TAG=v<x.y.z> node scripts/check-release.js`.
3. Run the checks above, ending with `package:vsix`, `check:package`,
   `test:vsix`, and `test:trust`.
4. Do these manual checks, which automated tests cannot cover:
   - physical `Tab`, `Enter`, `Shift+Enter`, and `Mod-` keybindings, undo,
     completion popups, Tab focus mode, and IME input on Windows and macOS;
   - granting trust to a workspace that opened in Restricted Mode;
   - a virtual workspace and a remote extension host.
5. Publish the checked VSIX from the
   [Marketplace publisher page](https://marketplace.visualstudio.com/manage/publishers/),
   or with `npx vsce publish --packagePath latex-suite-vscode-<version>.vsix`. See the
   [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
   for authentication; prefer Microsoft Entra ID, since global Azure DevOps PATs
   are retired on December 1, 2026. Keep credentials out of the repository.
6. Tag the release commit.

The publisher ID in `package.json` (`qmvis`) must match the
Marketplace publisher. If it changes, update every use of the extension ID
(`qmvis.latex-suite-vscode`) in `src/extension.ts` and `src/test/`, then
repackage.
