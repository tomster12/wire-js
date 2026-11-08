# Wire.js

Wire is a single file that makes a plain HTML page reactive, with no build step. You create signals in JavaScript and bind them to the page with `<wire>` and `<component>` elements.

```html
<script src="wire.js"></script>
<script>
	const count = new Wire.State("count", 0);
</script>

<button onclick="count.update((n) => n + 1)">Add</button>
<wire to="@count"></wire>
```

`examples/example-1` is a one-page cheat sheet of every feature, and `examples/example-2` is a small app.

## Signals

A `State` holds a value, and a `Computed` derives one from other signals. Every signal has a name that is global, unique and a valid JavaScript identifier, because that name is also how markup refers to it.

```js
const total = new Wire.State("total", 0);
total.set(5);
total.update((value) => value + 1); // the callback must return the new value
total.get();

const double = new Wire.Computed("double", [total], (value) => value * 2);
double.get(); // recalculated on read if a dependency was set since

const stop = total.listen((value) => console.log(value)); // works on a Computed too
stop();
```

Updates are batched. Five `set()` calls in a row cause one render and one call to each listener, which sees the latest value. A primitive that is set to the value it already has is ignored, while an object always counts as a change, so you can mutate it in place and `set` it again.

A wire only re-renders, and a listener only runs, if the JSON snapshot of its output or value is different from last time. Functions, Maps, Sets and circular data can't be snapshotted, so they always count as changed, and a property set to `undefined` counts as missing.

If updates keep triggering each other, Wire gives up after 100 rounds with a `Wire.WireError`.

## Syntax

Attributes on `<wire>` and `<component>` take one of four forms: `@name` for a signal, `@{ expr }` for a JavaScript expression, plain text for a literal, or no value for a flag.

Inside the content of a wire or component, `{{ expr }}` inserts the result as escaped text, and `{{{ expr }}}` inserts it as markup, which you should only do with HTML your own code generated.

An expression can use any global, any signal by its name (`count.get()`), and the loop variables and component arguments in scope. A loop variable or argument wins over a signal with the same name.

## `<wire>`

A wire's own content is its template, and these attributes decide when and how it renders.

| Attribute | Value                    | Effect                                                        |
| --------- | ------------------------ | ------------------------------------------------------------- |
| `to`      | `@signal`                | Shows the value as escaped text, and can't have content       |
| `with`    | `@a @b`                  | Re-renders when any of these signals change                   |
| `for`     | `@signal` or `@{ expr }` | Repeats the content for each item                             |
| `each`    | literal                  | Names the current item, and needs `for`                       |
| `if`      | `@signal` or `@{ expr }` | Renders only while truthy, otherwise it is empty and hidden   |
| `else`    | flag                     | Renders when the previous sibling's `if` or `else` did not    |

`id`, `class`, `style`, `title`, `data-*` and `aria-*` pass through as normal HTML. Any other attribute throws, which catches typos.

```html
<wire to="@counter"></wire>

<!-- A wire only re-renders for the signals it names -->
<wire with="@counter @step">{{ counter.get() * step.get() }}</wire>

<wire for="@items" each="item">{{ item.name }}</wire>
<wire for="@{ allItems }" with="@filter" each="item">{{ item.name }}</wire>
<wire for="@{ Array(stars.get()).fill(0) }" with="@stars">★</wire>

<wire if="@loggedIn" with="@username">Hello {{ username.get() }}</wire>
<wire else if="@guest">Guest</wire>
<wire else>Please sign in</wire>

<wire with="@chart">{{{ chartSvg.get() }}}</wire>
<wire>Rendered once at {{ new Date().toLocaleTimeString() }}</wire>
```

Inside a loop, the loop variable is in scope for everything nested, including the `@{ }` attributes of nested elements. The outer template never looks inside a nested wire or component, which evaluates its own content with its own scope, so give those elements `@{ }` rather than `{{ }}`.

```html
<wire for="@list" each="bob">
	<wire if="@{ bob.cool }">{{ bob.name }} is cool</wire>
	<component instance name="badge" arg:label="@{ bob.name }"></component>
</wire>
```

## `<component>`

A component is a reusable template. You define it once with its argument names, then place instances of it wherever you need them.

```html
<component name="metric-card" arg:title arg:unit-label>
	<div>{{ title }}: {{ unitLabel }}</div>
</component>

<component instance name="metric-card" arg:title="Count" arg:unit-label="@{ unit.get() }"></component>
```

- HTML lowercases attribute names, so write multi-word arguments in kebab-case. `arg:unit-label` becomes `unitLabel` in the template.
- An argument is a `@signal`, an `@{ expr }` or a literal. Signals are reactive, expressions are evaluated when the instance renders, and literals are always strings, so use `@{ 42 }` for a number.
- The template sees its own arguments, signals and globals, but not the loop variables around the instance.
- An argument you leave out is `null`, and one the component doesn't declare throws.
- Definitions are mounted first, so an instance may appear above its definition. A component can render itself, which is how you draw a tree.
- Anything written inside an instance is discarded.

## Rendering

When a wire's output changes, it replaces its children. If nothing changed, the existing elements are left alone. Lists have no keys, so a change to a list rebuilds every row.

If the focused field is inside the children being replaced, it gets its focus, its typed text and its caret back, matched by position. This is best effort and doesn't restore scroll position or a pointer drag.

Children of a wire that re-rendered are unsubscribed straight away. A wire you remove from the page yourself stops listening the next time one of its signals changes.

## Updating the DOM straight away

DOM updates happen in a microtask after your code finishes, which is almost always what you want. The exception is code that needs the new DOM immediately, such as moving focus to something a signal just created:

```js
selectedId.set(42);
Wire.flush(); // render now, instead of at the end of the current task
document.querySelector("#row-42 input").focus();
```

Without the flush, `#row-42` wouldn't exist yet. Reading a signal never needs it, because a `Computed` is always current when read.

## Adding wires from JavaScript

Wires in the page are mounted for you once it has parsed. If your own code inserts new ones, mount them yourself:

```js
container.innerHTML = '<wire to="@count"></wire>';
Wire.mount(container);
```

## Errors

Wire's own errors are a `Wire.WireError` with a message saying what is wrong, and an expression that throws surfaces as its own error. One element failing never stops the others. The error is logged, added to the `Wire.errors` array, and the element gets a `data-wire-error` attribute holding the message, so you can see the broken one on the page.

```css
[data-wire-error] { outline: 2px solid red; }
```

After mounting, the page logs how many elements failed. Errors from later re-renders are logged and collected as well.

## Gotchas

- Always write `<wire></wire>`, because the browser ignores the `/` in `<wire />`.
- Wires can't go inside `<table>` or `<select>`, because the parser moves or drops them, and it moves text between table tags out of the table as well. Build the whole table in one `{{{ }}}` expression from a function (escape the values yourself), or lay it out with `display: table` divs.
- `<wire>` and `<component>` are inline elements, so add `wire, component { display: contents; }` to your CSS.
- An expression only updates for the signals its element names. Any other signal it reads goes stale.
- A `}}` ends an expression, so write `{{ ({ a: { b: 1 } }).a }}` with a space, and put a space after a `<` that follows a letter.
- `{{ }}` isn't allowed in wire or component attributes, so use `@{ }`.
- Create signals before the page finishes parsing. A wire that names an unknown signal fails to mount and is never retried. A component defined inside a re-rendering wire is registered twice and throws.
- Expressions are compiled with `new Function`, so a Content Security Policy must allow `unsafe-eval`.
- Don't put `{{ }}` data inside an inline handler like `onclick`, pass an id instead. Escaping also doesn't make a `javascript:` URL safe.
- A click that starts on a row which is replaced before the mouse is released is lost, so use `onmousedown` for rows that change often.
