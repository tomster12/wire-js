# Wire

Small javascript utility for imitating reactivity with minimal implementation and bloat.

## Guide

Import `wire.js` in a `<script>` inside html `<body>`:

```html
<script src="./wire.js"></script>
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

<wire over="stuff" with="item">
    <p>This item is: {{item.a}}</p>
</wire>
```

## To-Do

- Register / deregister HTML with the Wire singleton to handle nested wire elements.

- Dont rerender nested wire elements if higher up wire element will rerender entire block anyway.

- Specifically only re-render children elements with code blocks inside?

  - Likely toggelable through an additional attribute
