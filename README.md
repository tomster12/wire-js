# Wire.js

Minimal single-file reactive JS library.

## Signals

```js
const s = new Wire.State("name", initial);   // reactive state
s.set(value);                                // update
s.get();                                     // read

const c = new Wire.Computed("name", [s], v => v*2);   // derived
c.get();                                              // read
```

## `<wire>` Element

| Attribute | Usage                                           |
| --------- | ----------------------------------------------- |
| `to`      | Bind contents to signal                         |
| `with`    | Re-render contents on signal update             |
| `for`     | Render contents foreach element in signal array |
| `each`    | Variable name for element in `for`              |

```html
<wire to="@state"></wire>
<wire for="@list" each="item">{{item.name}}</wire>
<wire with>{{customExpression}}</wire>
```

## `<component>` Element

| Attribute         | Usage                                        |
| ----------------- | -------------------------------------------- |
| `name`            | Component template identifier                |
| `instance`        | Flags element as an instance of the template |
| `arg:NAME`        | Pass or define arguments                     |

Argument attributes on an `instance` are signals if defined with `@`, otherwise their values are hydrated as a template.

```html
<component name="card" arg:title arg:value>...</component>
<component instance name="card" arg:title="Count" arg:value="@counter"></component>
```
