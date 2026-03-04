# Wire.js

Minimal single-file reactive JS library with no build steps.

## Signals

```js
const s = new Wire.State("name", initial); // reactive state
s.set(value); // update
s.get(); // read

const c = new Wire.Computed("name", [s], (v) => v * 2); // derived state
c.get(); // read
```

## `<wire>` Element

**Content attributes** define what is rendered:

| Attribute | Type                      | Usage                                   |
| --------- | ------------------------- | --------------------------------------- |
| `to`      | `@signal` or `{{ expr }}` | Render value as element contents        |
| `for`     | `@signal` or `{{ expr }}` | Render template for each item in array  |
| `each`    | literal                   | Variable name for current item in `for` |

**Trigger attributes** define when to re-render:

| Attribute | Type                      | Usage                         |
| --------- | ------------------------- | ----------------------------- |
| `with`    | `@signal`                 | Re-render when signal changes |
| `if`      | `@signal` or `{{ expr }}` | Conditionally render element  |

```html
<!-- Render a value -->
<wire to="@counter"></wire>

<!-- Render a list -->
<wire for="@items" each="item">{{item.name}}</wire>

<!-- Render a list expression, re-renders driven by a signal -->
<wire for="{{ allItems }}" with="@filter" each="item">{{item.name}}</wire>

<!-- Conditional rendering -->
<wire if="{{ counter.get() % 2 == 0 }}" with="@counter">Even</wire>
```

> **Note**: `for` and `to` are mutually exclusive as they both drive the content of the element.

## `<component>` Element

| Attribute  | Usage                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| `name`     | Component identifier                                                    |
| `instance` | Marks element as an instance rather than a template definition          |
| `arg:NAME` | Define accepted arguments (on template) or pass arguments (on instance) |

Instance `arg:` values can be:

- `@signal` - subscribes and re-renders on change
- `{{ expr }}` - evaluated as a template expression
- a plain string - used as a literal value

```html
<!-- Define a template -->
<component name="metric-card" arg:title arg:value>
	<div class="card">
		<div>{{title}}</div>
		<div class="metric">{{value}}</div>
	</div>
</component>

<!-- Use an instance -->
<component instance name="metric-card" arg:title="Count" arg:value="@counter"></component>
```

## Attribute Value Types

| Syntax       | Type                 | Example                |
| ------------ | -------------------- | ---------------------- |
| `@name`      | Signal reference     | `to="@counter"`        |
| `{{ expr }}` | Evaluated expression | `if="{{ count > 5 }}"` |
| plain string | Literal value        | `arg:title="Hello"`    |
