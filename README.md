# LaTeX Suite

Type LaTeX math quickly in Markdown, LaTeX, and Quarto files. LaTeX Suite expands short
triggers into LaTeX as you type, turns `/` into fractions, and lets you `Tab`
through brackets and out of equations.

This is a VS Code port of
[Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite). It
uses the same snippet format and ships the same default snippets.

Requires VS Code 1.137 or newer (desktop).

## Try it

Open a Markdown file and type:

| Type | Result |
| --- | --- |
| `dm` | a `$$ … $$` display-math block |
| `mk` | inline math `$ … $` |
| `xsr` (in math) | `x^{2}` |
| `sin @t` (in math) | `\sin \theta` |
| `x/y` then `Tab` (in math) | `\frac{x}{y}` |

Press `Tab` to move to the next placeholder, past a closing bracket, or out of
the equation.

## Features

- **Snippets** expand automatically or on `Tab`, only where they make sense:
  in math, in text, or in code blocks. Triggers can be plain text or regular
  expressions, and replacements can be JavaScript functions.
- **Auto-fraction**: typing `/` in math turns the preceding expression, or the
  selection, into `\frac{…}{}`.
- **Matrix shortcuts**: inside `pmatrix`, `align`, `cases`, and similar
  environments, `Tab` adds ` & `, `Enter` starts a new row, and `Shift+Enter`
  leaves the environment.
- **Tab-out**: `Tab` jumps through snippet placeholders, then past closing
  brackets, then out of the equation.
- **Bracket enlargement**: when a snippet inserts something large like `\sum`
  or `\frac` inside brackets, they become `\left( … \right)`.

### Where math is detected

In Markdown: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, common math environments, and
code fences whose language is `math` (configurable with
`latexSuite.forceMathLanguages`). Inline code and other code fences are not math.

In LaTeX: the same delimiters and environments. Text inside `\text{…}` and
similar macros has its own context (the `T` option), and `%` comments block
snippets that have no context restriction.

The detector is built for editing speed. It is not a full TeX parser and does
not expand custom macro definitions.

## Custom snippets

By default you get the bundled snippet set. To use your own, run
**LaTeX Suite: Add Snippet File…** and pick a file. This adds it to
`latexSuite.snippets.files` in your User settings.

You can also configure snippets per project in `.vscode/settings.json`:

```json
{
  "latexSuite.snippets.files": [".vscode/latex-suite/snippets.js"],
  "latexSuite.snippets.variableFiles": [".vscode/latex-suite/variables.js"]
}
```

Things to know:

- **Custom snippets replace the bundled set.** They are not merged. To build
  on the defaults, start from a copy of
  [the bundled snippets](https://github.com/Nicswansonwaterloo/latex-suite-vscode/blob/main/src/upstream/default_snippets.js).
- Relative paths resolve against the workspace folder of the open file. A
  folder path loads every file inside it, including subfolders, in path order.
- Snippets can also be written inline in `latexSuite.snippets.source`. Set it to
  `[]` to turn off all snippets.
- Files are not watched. After editing one, run **LaTeX Suite: Reload Snippets**.
- Errors are shown in the **LaTeX Suite** output channel. If a custom source
  fails to load, the bundled snippets are not used in its place.

### Snippet format

A snippet file is JavaScript that exports an array, using `export default`,
`module.exports`, or a bare array:

```js
export default [
  { trigger: "@l", replacement: "\\lambda", options: "mA" },
  { trigger: "sq", replacement: "\\sqrt{${0:x}}$1", options: "m" },
  {
    trigger: /([A-Za-z])(\d)/,
    replacement: "[[0]]_{[[1]]}",
    options: "mA",
    priority: 10,
    description: "Single-letter subscript"
  },
  { trigger: "(", replacement: "\\left( ${VISUAL} \\right)$0", options: "mv" }
];
```

Because this is JavaScript, a LaTeX backslash is written `\\`.

| Field | Meaning |
| --- | --- |
| `trigger` | Text or `RegExp` matched just before the cursor |
| `replacement` | Text, a function, or an array of snippet nodes |
| `options` | Option letters from the table below |
| `priority` | Higher matches first (default `0`) |
| `description` | Shown in debug logs |
| `flags` | Regex flags: `i`, `m`, `s`, `u`, or `v` |
| `triggerAfter` | Text or regex that must follow the cursor; it is replaced too |
| `triggerKey` | Expand from a key binding, e.g. `Ctrl-a` or `Mod-Alt-l` |
| `language` | Code-fence language, for `c` snippets |
| `excludedMacros` / `excludedEnvironments` | Don't expand inside these |
| `includedMacros` | Only expand inside these |

| Option | Meaning |
| --- | --- |
| `m` | In math (inline or display) |
| `n` | In inline math |
| `M` | In display math |
| `t` | In text, outside math |
| `T` | In text inside math, such as `\text{…}` |
| `c` | In a Markdown code block (use `language` to pick one) |
| `C` | In Markdown inline code |
| `A` | Expand automatically, without `Tab` |
| `r` | Treat a string trigger as a regular expression |
| `v` | Visual: wrap the current selection |
| `w` | Only match at word boundaries |
| `U` | Skip the extra undo step that restores just the typed trigger |

With no mode letter, a snippet works everywhere. Several mode letters mean
"any of these".

**Placeholders.** `$0`, `$1`, … and `${1:default}` are tab stops, visited in
order with `Tab`. Repeating a number links the copies so they are edited
together.

**Regex captures.** In a regex snippet's replacement, `[[0]]`, `[[1]]`, … insert
the first, second, … capture group.

**Visual snippets** (`v`) run when you select text and type the trigger
character. `${VISUAL}` inserts the selection.

**Matching order.** Higher `priority` first, then longer triggers, then file
order.

**Macro scopes.** In `excludedMacros` and `includedMacros`, a name like
`"text"` refers to the macro's first argument. Use `{ name: "macro" }` for all
arguments, or `{ name: "macro", arguments: [0, 2] }` for specific ones
(counted from 0).

### Snippet variables

Variables are reusable regex fragments. A variable file exports an object:

```js
export default {
  GREEK_LOWER: "(?:alpha|beta|gamma|delta)"
};
```

Use one in a trigger with `${GREEK_LOWER}`, for example
`trigger: "(${GREEK_LOWER})hat"`. The bundled variables are always available,
including with custom snippets. Your variables are added to them and override
any with the same name.

### Function replacements

A replacement function receives the match (or the selected text, for visual
snippets). It returns a string, an array of snippet nodes, or `false` to skip
the match.

```js
const ls = require("latex-suite");

module.exports = [
  {
    trigger: /iden(\d)/,
    options: "mA",
    replacement: (match) => {
      const n = Number(match[1]);
      const rows = Array.from({ length: n }, (_, row) =>
        Array.from({ length: n }, (_, col) => (row === col ? "1" : "0")).join(" & ")
      );
      return `\\begin{pmatrix}\n${rows.join(" \\\\\n")}\n\\end{pmatrix}`;
    }
  },
  {
    trigger: /(\w)(\d)/,
    options: "mrA",
    replacement: [ls.capture_node(0), ls.text_node("_{"), ls.capture_node(1), ls.text_node("}")]
  }
];
```

`require("latex-suite")` provides `snippetVariables`, `tabstop_node`,
`text_node`, `capture_node`, `snippet_node`, `array_node`, and `ALL_MACROS`. The
function's second argument includes `adapter` (also available as `view`), which
exposes the VS Code `document` and a small read-only CodeMirror-like `state`.
Snippets that rely on Obsidian or full CodeMirror APIs need to be adapted.

### Security

Custom snippet and variable files are code. They run unsandboxed in the VS Code
extension host and can read files or start processes. Only load snippets you
trust, and check a project's `.vscode/settings.json` before trusting the
workspace.

In [Restricted Mode](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust),
custom snippets and variables are never loaded; the bundled set is used.

In virtual workspaces, custom snippets work but cannot `require` other files
by relative path.

## Commands

All commands are in the Command Palette under **LaTeX Suite**.

| Command | Default key |
| --- | --- |
| Expand Snippet | `Tab` |
| Expand Snippet by Trigger Key | — |
| Insert Auto-fraction | — (`/` works automatically in math) |
| Move to Next Bracket or Exit Equation | `Tab` |
| Add Matrix Cell | `Tab` in a matrix |
| Add Matrix Row | `Enter` in a matrix |
| Exit Matrix | `Shift+Enter` in a matrix |
| Reload Snippets | — |
| Add Snippet File… / Add Variable File… | — |
| Toggle Typing Shortcuts | — |
| Open Settings | — |

### How `Tab` works

`Tab` does the first of these that applies: move to the next snippet
placeholder, expand a `Tab` snippet, add a matrix cell, jump past the next
closing bracket, leave the equation, or insert a normal tab.

The `Tab` binding is active only when `editor.tabCompletion` is `off` (the
default). If you use Tab Completion, bind `latexSuite.tab` to a key yourself.

### Trigger-key snippets

To run a snippet that has a `triggerKey`, add a keybinding:

```json
{
  "key": "ctrl+alt+l",
  "command": "latexSuite.expandSnippetByKey",
  "when": "editorTextFocus && !editorReadonly && !editorHasMultipleSelections",
  "args": { "triggerKey": "Ctrl-Alt-l" }
}
```

Write `triggerKey` in CodeMirror style: `Ctrl-`, `Alt-`, `Shift-`, `Meta-`, or
`Mod-` (`Cmd` on macOS, `Ctrl` elsewhere). Space-separated key sequences work.

## Settings

Run **LaTeX Suite: Open Settings** to see every setting with its description.
Settings can be set for the user, a workspace, or a single folder in a
multi-root workspace.

Edit **LaTeX Suite: File Extensions** to choose which file types activate the
extension, for example `[".tex", ".md", ".qmd", ".rmd"]`. Extensions are
case-insensitive and may omit the leading dot. An empty list disables all file
types. Untitled Markdown and LaTeX documents follow the `.md` and `.tex` entries.
LaTeX files use LaTeX context detection; other configured types use Markdown
context detection.

| Setting | Default | What it does |
| --- | --- | --- |
| `latexSuite.enabled` | `true` | Turn all shortcuts on or off |
| `latexSuite.fileExtensions` | `[".tex", ".md", ".qmd"]` | File types where shortcuts are active; changes apply immediately |
| `latexSuite.snippets.enabled` | `true` | Snippet expansion |
| `latexSuite.snippets.files` | `[]` | Your snippet files or folders |
| `latexSuite.snippets.source` | `""` | Inline snippets |
| `latexSuite.snippets.variableFiles` | `[]` | Your snippet variable files |
| `latexSuite.snippets.variablesSource` | `""` | Inline snippet variables |
| `latexSuite.snippets.recursionLimit` | `0` | Let automatic snippets expand on each other's output (up to 10 times) |
| `latexSuite.snippets.wordDelimiters` | punctuation and whitespace | Word boundaries for the `w` option |
| `latexSuite.snippets.removeTrailingWhitespace` | `true` | Trim trailing spaces from snippets in inline math |
| `latexSuite.forceMathLanguages` | `["math"]` | Code-fence languages treated as math |
| `latexSuite.autoFraction.enabled` | `true` | Auto-fraction on `/` |
| `latexSuite.autoFraction.symbol` | `\frac` | Fraction command to insert |
| `latexSuite.autoFraction.breakingCharacters` | `+-=` and tab | Characters that end the numerator |
| `latexSuite.autoFraction.excludedRegions` | `^{…}`, `\pu{…}` | Where `/` stays a slash |
| `latexSuite.matrixShortcuts.enabled` | `true` | Matrix `Tab`/`Enter`/`Shift+Enter` |
| `latexSuite.matrixShortcuts.environments` | `pmatrix`, `align`, `cases`, … | Environments with matrix shortcuts |
| `latexSuite.matrixShortcuts.macros` | `["eqalign"]` | Macros with matrix shortcuts |
| `latexSuite.tabOut.enabled` | `true` | `Tab` past brackets and out of equations |
| `latexSuite.tabOut.closingSymbols` | `)`, `]`, `}`, `\rangle`, … | Brackets `Tab` jumps past |
| `latexSuite.tabOut.exitEquationOnlyAtEndOfLine` | `true` | Only leave an equation when nothing but whitespace remains in it |
| `latexSuite.bracketEnlargement.enabled` | `true` | Add `\left`/`\right` automatically |
| `latexSuite.bracketEnlargement.triggers` | `\sum`, `\int`, `\frac`, … | What triggers enlargement |
| `latexSuite.bracketEnlargement.insertSpaces` | `true` | Pad enlarged brackets with spaces |
| `latexSuite.debug` | `off` | Log expansions to the output channel |

## Limitations

- Concealment, hover previews, bracket highlighting, and Vim mode from the
  Obsidian plugin are not included.
- Shortcuts work with one cursor only, not multiple cursors or selections.
- Automatic expansion responds to typing one character at a time. Pasting,
  undo/redo, and IME input may not trigger it.
- vscode.dev and other browser-only editors are not supported.

## Contributing

Bug reports and pull requests are welcome on
[GitHub](https://github.com/Nicswansonwaterloo/latex-suite-vscode/issues). See
the [development guide](https://github.com/Nicswansonwaterloo/latex-suite-vscode/blob/main/DEVELOPMENT.md)
for building and testing.

## Credits and license

Based on [Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite)
v1.13.1 by artisticat1, used under the MIT License. Differences from upstream
are listed in `UPSTREAM.md`. See `LICENSE`, `src/upstream/LICENSE.md`, and
`THIRD_PARTY_NOTICES.md`. This is an independent port, not an official release
of Obsidian LaTeX Suite.
