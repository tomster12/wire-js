# Wire.js for VS Code

Local extension for HTML files using Wire.js.

- Completion and hover for `<wire>` and `<component>` and their attributes (`to`, `with`, `for`, `each`, `if`, `else`, `name`, `instance`, `arg:`), and for the attributes any element can carry: `on:click` and the other events, `bind:value`, `bind:checked`, and `:class`, `:disabled`, `:value` and the other one-way bindings
- JavaScript highlighting inside `{{ ... }}` (escaped output), `{{{ ... }}}` (unescaped output) and `@{ ... }` (attribute expressions, including multi-statement `on:` handlers)
- `@signal` references, including several in `with="@a @b"`, and the `arg:`, `on:`, `bind:` and `:` attribute names highlighted
- Go to definition: `@signal` jumps to `new Wire.State("signal")` / `new Wire.Computed("signal")`, a bare signal name inside an expression (`count` in `{{ count.get() }}` or `on:click="@{ count.update(...) }"`) does the same, and a component `name` jumps to its template
- Snippets (HTML and JavaScript files): `wire-to`, `wire-expr`, `wire-raw`, `wire-once`, `wire-with`, `wire-for`, `wire-for-expr`, `wire-if`, `wire-else-if`, `wire-else`, `wire-component`, `wire-instance`, `wire-on`, `wire-button`, `wire-attr`, `wire-attr-expr`, `wire-bind`, `wire-bind-number`, `wire-bind-checkbox`, `wire-bind-select`, `wire-bind-item`, `wire-state`, `wire-computed`, `wire-listen`, `wire-update`, `wire-mount`, `wire-flush`

## Install

Copy or symlink this folder into `%USERPROFILE%\.vscode\extensions\wire-js-0.3.0` and reload VS Code.
Or run `npx @vscode/vsce package` here and use *Extensions: Install from VSIX...*.
