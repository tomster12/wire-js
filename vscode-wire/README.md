# Wire.js for VS Code

Local extension for HTML files using Wire.js.

- Completion and hover for `<wire>` and `<component>` and their attributes (`to`, `with`, `for`, `each`, `if`, `else`, `name`, `instance`, `arg:`)
- JavaScript highlighting inside `{{ ... }}` (escaped output), `{{{ ... }}}` (unescaped output) and `@{ ... }` (attribute expressions)
- `@signal` references, including several in `with="@a @b"`, and `arg:name` attributes highlighted
- Go to definition: `@signal` jumps to `new Wire.State("signal")` / `new Wire.Computed("signal")`, and a component `name` jumps to its template
- Snippets (HTML and JavaScript files): `wire-to`, `wire-expr`, `wire-raw`, `wire-once`, `wire-with`, `wire-for`, `wire-for-expr`, `wire-if`, `wire-else-if`, `wire-else`, `wire-component`, `wire-instance`, `wire-state`, `wire-computed`, `wire-listen`

## Install

Copy or symlink this folder into `%USERPROFILE%\.vscode\extensions\wire-js-0.2.0` and reload VS Code.
Or run `npx @vscode/vsce package` here and use *Extensions: Install from VSIX...*.
