# Wire.js

Minimal single-file no-build reactivity JS lib. Include `wire.js`, create signals, and bind them to `<wire>` and `<component>` elements in your HTML.

```html
<script src="wire.js"></script>
<script>
	const count = new Wire.State("count", 0);
</script>

<button onclick="count.update((n) => n + 1)">Add</button>
<wire to="@count"></wire>
```

`examples/example-1` is a tour of every feature and edge case, and `examples/example-2` is a small app.

## Signals

```js
const s = new Wire.State("name", initial); // reactive state, names are global and unique
s.set(value); // update
s.update((v) => v + 1); // set from the current value
s.get(); // read

const c = new Wire.Computed("name", [s], (v) => v * 2); // derived state, dependencies are always listed
c.get(); // read, always current

const stop = c.listen((v) => console.log(v)); // your own callback, stop() unsubscribes
Wire.flush(); // apply pending DOM updates now
```

Everything is exposed through the single `Wire` global: `Wire.Signal`, `Wire.State`, `Wire.Computed`, `Wire.flush()`, `Wire.signalNames()`, `Wire.controller` (`mountElement`, `mountElements`) and `Wire.errors`. `signal.subscriberCount` counts listeners plus the wires and computeds watching the signal, while `signal.listeners.size` is only your `listen()` callbacks.

## Syntax

On Wire element attributes:

| Form         | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `@name`      | a signal                                                       |
| `@{ expr }`  | a JavaScript expression, with loop variables and args in scope |
| `text`       | a literal                                                      |
| _(no value)_ | a flag                                                         |

In template text (the content of a `<wire>` or `<component>`):

| Form           | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `{{ expr }}`   | the result, HTML-escaped                                      |
| `{{{ expr }}}` | the result as markup, unescaped (only for HTML you generated) |

Expressions are plain JavaScript with access to every global, plus loop variables and component args. They are compiled with `new Function`, so a Content Security Policy must allow `unsafe-eval`. Always close the elements (`<wire ...></wire>`), the browser ignores `/>` on them.

## `<wire>` element

| Attribute | Accepts                  | Effect                                                     |
| --------- | ------------------------ | ---------------------------------------------------------- |
| `to`      | `@signal`                | Render the signal's value as escaped text                  |
| `for`     | `@signal` or `@{ expr }` | Render the content for each item in an array               |
| `each`    | literal                  | Variable name for the current item in `for`                |
| `with`    | `@a @b ...`              | Re-render when any of these signals change                 |
| `if`      | `@signal` or `@{ expr }` | Render only while truthy, otherwise empty and hidden       |
| `else`    | flag                     | Render when the previous sibling's `if` / `else` was false |
| `style`   | literal                  | Plain attribute                                            |
| `class`   | literal                  | Plain attribute                                            |

An element's own content is its template, and `{{ }}` in it is evaluated when it renders. `to` cannot have content and is exclusive with `for`; `each` requires `for`.

```html
<!-- Render a signal -->
<wire to="@counter"></wire>

<!-- Render an expression, re-rendered when either signal changes -->
<wire with="@counter @step">{{ counter.get() * step.get() }}</wire>

<!-- No attributes: the template renders once -->
<wire>Loaded at {{ new Date().toLocaleTimeString() }}</wire>

<!-- Render a list, from a signal or from an expression -->
<wire for="@items" each="item">{{ item.name }}</wire>
<wire for="@{ allItems }" with="@filter" each="item">{{ item.name }}</wire>

<!-- Repeat n times -->
<wire for="@{ Array(stars.get()).fill(0) }" with="@stars">★</wire>

<!-- Conditions, chained with else -->
<wire if="@loggedIn" with="@username">Hello {{ username.get() }}</wire>
<wire else if="@guest">Guest</wire>
<wire else>Please sign in</wire>

<!-- Markup your own code generated -->
<wire with="@chart">{{{ chartSvg.get() }}}</wire>
<svg>{{{ shapes }}}</svg>
```

An element only re-renders for the signals it names (`to`, `for`, `if`, `with`). An expression that reads a signal missing from them goes stale.

### Scope

Loop variables are visible to everything nested inside the loop, including `@{ }` attributes of nested elements:

```html
<wire for="@list" each="bob">
	{{ bob.name }}
	<wire if="@{ bob.cool }">is cool</wire>
	<component instance name="badge" arg:label="@{ bob.name }"></component>
</wire>
```

The outer template does not evaluate the content of nested `<wire>` and `<component>` elements (only their tags). They evaluate their own content, with their own scope.

Inside a template, `{{ }}` and `{{{ }}}` are plain text substitution and also work inside quoted attribute values of nested elements: `<wire if="@{ {{ bob.cool }} }">` becomes `<wire if="@{ true }">`, and `arg:id="{{ bob.id }}"` arrives as a string while `arg:id="@{ bob.id }"` keeps its type.

## `<component>` element

| Attribute  | Accepts                                                              | Effect                                                         |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `name`     | literal                                                              | Names the template, or selects the one to render               |
| `instance` | flag                                                                 | Renders the named template instead of defining it              |
| `arg:NAME` | flag on a definition; `@signal`, `@{ expr }` or literal on an instance | Declares an argument, or supplies its value                    |

```html
<component name="metric-card" arg:title arg:value>
	<div class="card">
		<div>{{ title }}</div>
		<div class="metric">{{ value }}</div>
	</div>
</component>

<component instance name="metric-card" arg:title="Count" arg:value="@counter"></component>
```

A component's template sees only its own arguments and globals. Arguments you leave out are `null`. A `@signal` argument is reactive, an `@{ }` argument is evaluated when the instance renders and is not reactive on its own.

## Rendering behaviour

- **Equality:** `set()` is silent for the same primitive and for a different object that is shallow-equal to the current one. Setting the same object again always notifies, because it may have been mutated in place.
- **Batching:** DOM updates and `Computed` recalculation are batched and applied at the end of the microtask, so several `set()` calls cause one update. `State` listeners run immediately, `Computed` listeners run with the batch. `Wire.flush()` applies the batch now, which you only need when code reads the DOM right after a `set()`. Reading a signal never needs it.
- **Laziness:** a `Computed` only subscribes to its sources while something is watching it.
- **Cycles:** if updates keep triggering each other, Wire stops after 100 rounds and throws `Wire.errors.WireCycleError`.
- **Re-renders:** a re-render replaces the element's children unless the new HTML and items are identical to the last render. Anything rendered from a signal that was set with the same object is always rebuilt.
- **Focus:** when children are replaced, the focused field gets its focus, typed text and caret back, matched by position. This is best effort: scroll position, other typed fields and pointer drags are not restored, so keep such controls outside the re-rendering `<wire>`.
- **Cleanup:** wires removed from the page are unsubscribed.

## Edge cases

- A `}}` inside an expression ends it, so write `{{ ({ a: { b: 1 } }).a }}` with a space between closing braces.
- A bare `{{ x }}` between attributes (`<wire {{ x }}>`) does not work in page markup, the browser turns it into attributes. Put it inside a quoted value.
- On a page, `{{ }}` in a `<wire>` or `<component>` attribute throws, since nothing can substitute it. Inside a template it is substituted as text.
- Substituted text is read as markup afterwards. A value starting with `@` or `@{` in a nested tag attribute is read as Wire syntax, so substitute only values you control.
- Event handlers are plain inline attributes. Putting data inside one, such as `onclick="f('{{ name }}')"`, can break out of the string, so pass an id instead.
- Lists are rebuilt when their output changes, so a click that starts on a row replaced before release is lost. Use `onmousedown` for rows that change often.
- Signal and component names are global and unique, registering a name twice throws.
- `class` and `style` are plain attributes, never parsed as Wire syntax.

## Errors

All are exposed on `Wire.errors`: `WireAttributeError` (bad attributes or attribute values), `WireRegistrationError` (unknown or duplicate signal or component name), `WireHydrationError` (an unclosed `{{ }}`) and `WireCycleError` (updates that never settle). An expression that throws, such as an unknown variable, surfaces as the original error. Mount-time errors are thrown; errors in a later re-render are logged to the console.
