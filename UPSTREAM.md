# Upstream attribution

This extension ports typing and snippet behavior from
[Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite),
licensed under the MIT License (see `src/upstream/LICENSE.md`).

The bundled snippet variables and macro catalogue come from version 1.13.1,
commit `ee9f3ee05e98e8144a56f74e8f218eda47bcccea`. Snippet matching, context
detection, auto-fraction, matrix shortcuts, tab-out, and bracket enlargement are
adapted for VS Code, which handles editing, placeholders, and undo.

## Differences from upstream

The behavioral reference for reverse tab-out, math highlighting, and automatic
snippet reload is upstream 1.14.5. [Pinned source at `95b654a`](https://github.com/artisticat1/obsidian-latex-suite/tree/95b654afb28cecb305656d0912b34abab3d8033d).

- Reverse tab-out searches the current equation for the preceding opening
  delimiter. It can cross the equation opener when the same whitespace rule
  used by forward tab-out permits it. VS Code handles previous snippet
  placeholders, selections, Tab focus mode, and ordinary outdent.
- Bracket colors, cursor-pair highlighting, and math-delimiter colors are
  independent VS Code decorations that follow the editor theme. Cursor
  highlighting requires touching a bracket. Upstream also highlights an
  enclosing pair from the middle of its contents or from a selection. The
  port uses its Markdown and LaTeX context scanner for equation boundaries.
  For example, a lone `$$` is an unfinished display opener. Its color stays
  the same when the cursor enters or leaves it.
- Trusted snippet and variable sources reload through the existing loader.
  VS Code filesystem events cover both sides of a rename and changes in
  nested directories. A burst of changes refreshes only the workspace
  folders that use those paths. Watches start on first use, and the manual
  Reload Snippets command remains available when a provider skips events.
  Windows local sources use metadata polling to avoid VS Code file watchers
  locking parent directories against rename. Pending expansions follow a
  replacement file load while retaining the editor and configuration guards.

Earlier upstream changes reviewed through 1.13.3 include the following.

- From 1.13.2: required-argument limits for text and snippetless macros
  (including `colorbox`, `fcolorbox`, `operatorname`, and style macros), and the
  inline `beg` trigger fix. A macro named by a string matches its first
  argument; an object without `arguments` matches every argument.
- `dm` keeps this port's behavior. Upstream 1.13.2 changed how leading newlines
  and blockquotes are handled; that change is not included.
- File types are configurable with `latexSuite.fileExtensions` (default `.tex`,
  `.md`, and `.qmd`), including files with other VS Code language IDs.
- `mk` omits the empty groups that Obsidian inserts to avoid preview flicker.
- Concealment, previews, Vim support, and Obsidian integrations such as
  Excalidraw remain outside this port.
