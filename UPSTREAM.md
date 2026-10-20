# Upstream attribution

This extension ports typing and snippet behavior from
[Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite),
licensed under the MIT License (see `src/upstream/LICENSE.md`).

The bundled snippet variables and macro catalogue come from version 1.13.1,
commit `ee9f3ee05e98e8144a56f74e8f218eda47bcccea`. Snippet matching, context
detection, auto-fraction, matrix shortcuts, tab-out, and bracket enlargement are
adapted for VS Code, which handles editing, placeholders, and undo.

## Differences from upstream

Upstream changes through 1.13.3 have been reviewed. This port includes some of
them, not all.

- From 1.13.2: required-argument limits for text and snippetless macros
  (including `colorbox`, `fcolorbox`, `operatorname`, and style macros), and the
  inline `beg` trigger fix. A macro named by a string matches its first
  argument; an object without `arguments` matches every argument.
- `dm` keeps this port's behavior. Upstream 1.13.2 changed how leading newlines
  and blockquotes are handled; that change is not included.
- File types are configurable with `latexSuite.fileExtensions` (default `.tex`,
  `.md`, and `.qmd`), including files with other VS Code language IDs.
- `mk` omits the empty groups that Obsidian inserts to avoid preview flicker.
- Concealment, previews, file watching, Vim support, and Obsidian-specific
  features such as Excalidraw do not apply to VS Code and are not ported.
