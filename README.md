# Wire JS

Minimal implementation for imitating reactivity with plain JS.

Intended to work HTML first - you define the components that you want to react in the HTML directly.

## Guide

Import `wire.js` in a `<script>` inside html `<body>`:

```html
<body>
    <script src="./wire.js"></script>
    ...
</body>
```

Define `State` or `Computed` signals inside another `<script>`:

```html
<script>
    counter = new State("counter", 2);
    double = new Computed("double", [counter], (c) => c * 2);
    list = new State("stuff", [{a:1}, {a:2}, {a:3}]);
</script>
```

Use `<wire>` tags to hook into these signals:

```html
<button onclick="counter.set(counter.get() + 1)">
    Counter: <wire to="counter" />
</button>

<p>Double: <wire to="double" /></p>

<wire with="double">
    Rerendered when double is updated.
    Double value is {{double.get()}}.
</wire>

<wire for="stuff" each="item">
    <p>This item is: {{item.a}}</p>
</wire>
```

## To-Do

- Dont rerender nested wire elements if higher up wire element will rerender entire block anyway.

- Specifically only re-render children elements with code blocks inside?

  - Likely toggelable through an additional attribute

- Scoped variables for nested elements