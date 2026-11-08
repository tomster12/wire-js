// ---------- Syntax highlighting (tiny, no dependencies) ----------

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const token = (kind, text) => `<span class="${kind}">${escapeHtml(text)}</span>`;

const JS_TOKEN =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|of|in|new|typeof|try|catch|finally|true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b|\b(Wire(?:\.[A-Za-z]+)?|Date|JSON|Array|console)\b|([A-Za-z_$][\w$]*)(?=\()/g;
const JS_KINDS = ["", "c", "s", "k", "n", "w", "f"];

function highlightJs(source) {
	let html = "";
	let last = 0;
	for (const match of source.matchAll(JS_TOKEN)) {
		html += escapeHtml(source.slice(last, match.index));
		html += token(JS_KINDS[match.findIndex((group, index) => index && group)], match[0]);
		last = match.index + match[0].length;
	}
	return html + escapeHtml(source.slice(last));
}

const WIRE_ATTRIBUTES = new Set(["to", "with", "for", "each", "if", "else", "name", "instance"]);

function highlightValue(value) {
	if (value.startsWith("@{") && value.endsWith("}")) return token("p", "@{") + highlightJs(value.slice(2, -1)) + token("p", "}");
	return token(value.startsWith("@") ? "v" : "s", value);
}

function highlightTag(source, start) {
	let html = token("p", "<");
	let i = start + 1;
	if (source[i] === "/") {
		html += token("p", "/");
		i++;
	}
	const tagName = /^[\w-]+/.exec(source.slice(i))[0];
	html += token("t", tagName);
	i += tagName.length;

	while (i < source.length) {
		const char = source[i];
		if (char === ">") return [html + token("p", ">"), i + 1];
		if (/\s/.test(char)) html += char;
		else if (char === "/") html += token("p", "/");
		else {
			const attribute = /^[^\s=>/]+/.exec(source.slice(i));
			if (!attribute) {
				html += escapeHtml(char);
				i++;
				continue;
			}
			const name = attribute[0];
			i += name.length;
			html += token(/^(on:|bind:|arg:|:)/.test(name) ? "d" : WIRE_ATTRIBUTES.has(name) ? "d2" : "a", name);
			if (source[i] === "=" && (source[i + 1] === '"' || source[i + 1] === "'")) {
				const quote = source[i + 1];
				const end = source.indexOf(quote, i + 2);
				const close = end === -1 ? source.length : end;
				html += token("p", "=" + quote) + highlightValue(source.slice(i + 2, close)) + token("p", quote);
				i = close + 1;
				continue;
			}
			continue;
		}
		i++;
	}
	return [html, i];
}

function highlightMarkup(source) {
	let html = "";
	let i = 0;
	while (i < source.length) {
		if (source.startsWith("{{", i)) {
			const open = source.startsWith("{{{", i) ? "{{{" : "{{";
			const close = open === "{{{" ? "}}}" : "}}";
			const end = source.indexOf(close, i + open.length);
			if (end !== -1) {
				html += token("p", open) + highlightJs(source.slice(i + open.length, end)) + token("p", close);
				i = end + close.length;
				continue;
			}
		}
		if (source[i] === "<" && /[\w/]/.test(source[i + 1] || "")) {
			const [tagHtml, next] = highlightTag(source, i);
			html += tagHtml;
			i = next;
			continue;
		}
		html += escapeHtml(source[i]);
		i++;
	}
	return html;
}

// Trims blank edge lines and the common tab indent
function dedent(text) {
	const lines = text.split("\n");
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^\t*/)[0].length));
	return lines.map((line) => line.slice(indent)).join("\n");
}

// Runs before Wire mounts, so the printed markup is exactly what the page contains
function fillSourceBlocks() {
	for (const block of document.querySelectorAll("pre[data-source-of]")) {
		// innerHTML escapes some characters and writes empty attributes as name="", undo both
		const decoder = document.createElement("textarea");
		decoder.innerHTML = document.getElementById(block.dataset.sourceOf).innerHTML;
		block.innerHTML = highlightMarkup(dedent(decoder.value.replace(/ ([\w:-]+)=""/g, " $1")));
	}
	for (const script of document.querySelectorAll('script[type="text/plain"]')) {
		const block = document.createElement("pre");
		block.innerHTML = highlightJs(dedent(script.textContent));
		script.replaceWith(block);
	}
}

// ---------- Demo state ----------

// Core
const count = new Wire.State("count", 0);
const double = new Wire.Computed("double", [count], (value) => value * 2);
new Wire.Computed("quadruple", [double], (value) => value * 2);
const added = new Wire.State("added", ["ada"]);

// Batching
let computeCalls = 0;
const hits = new Wire.State("hits", 0);
new Wire.Computed("hitsSquared", [hits], (value) => {
	computeCalls++;
	return value * value;
});
const flushReport = new Wire.State("flushReport", "");

function flushDemo() {
	const target = document.getElementById("hits-value");
	hits.update((value) => value + 1);
	const before = target.textContent;
	Wire.flush();
	flushReport.set(`DOM before flush: ${before}, after: ${target.textContent}`);
}

// Bindings
new Wire.State("fullName", "Ada");
new Wire.State("age", 36);
new Wire.State("subscribed", true);
new Wire.State("color", "blue");
new Wire.State("volume", 30);

// Equality
const point = new Wire.State("point", { x: 1, y: 2 });
const pointRuns = new Wire.State("pointRuns", 0);
const number = new Wire.State("number", 5);
const numberRuns = new Wire.State("numberRuns", 0);
point.listen(() => pointRuns.update((total) => total + 1));
number.listen(() => numberRuns.update((total) => total + 1));

// Expressions, conditions
new Wire.State("userText", "");
const trustedMarkup = "<b>bold</b> and <i>italic</i> from our own code";
const a = new Wire.State("a", 2);
const b = new Wire.State("b", 3);
new Wire.State("score", 60);
const flag = new Wire.State("flag", true);

// Lists
const todos = new Wire.State("todos", [
	{ id: 1, title: "Write the docs", done: true, tags: ["docs", "writing"] },
	{ id: 2, title: "Ship it", done: false, tags: ["release"] },
	{ id: 3, title: "<b>not bold</b> {{ 1 + 1 }}", done: false, tags: [] },
]);
const stars = new Wire.State("stars", 3);
const filter = new Wire.State("filter", "");

function toggleTodo(id) {
	todos.update((list) => list.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
}

function sortTodos() {
	todos.update((list) => [...list].sort((left, right) => left.title.localeCompare(right.title)));
}

function addTodo() {
	todos.update((list) => [...list, { id: list.length + 1, title: `Item ${list.length + 1}`, done: false, tags: ["new"] }]);
}

// Components
const userName = new Wire.State("userName", "Ada");
const tree = new Wire.State("tree", {
	name: "root",
	children: [{ name: "a", children: [{ name: "a1", children: [] }] }, { name: "b", children: [] }],
});

// Re-render and mount
const tick = new Wire.State("tick", Date.now());
setInterval(() => tick.set(Date.now()), 1000);

function insertWire() {
	const target = document.getElementById("insert-target");
	target.insertAdjacentHTML("beforeend", `<wire to="@count"></wire> `);
	Wire.mount(target);
}

// Errors
function mountedErrorMessage(markup) {
	const holder = document.createElement("div");
	holder.innerHTML = markup;
	const errorCountBefore = Wire.errors.length;
	Wire.mount(holder);
	return Wire.errors.length > errorCountBefore ? Wire.errors[errorCountBefore].message.slice(0, 110) : "no error";
}

const brokenMarkup = [
	'<wire banana="1"></wire>',
	'<wire for="@items" to="@items"></wire>',
	'<wire to="@count">content</wire>',
	'<wire if="{{ true }}"></wire>',
	'<wire to="@ghost"></wire>',
	'<component instance name="nope"></component>',
	'<wire with="@count">{{ oops</wire>',
];
new Wire.State(
	"validationResults",
	brokenMarkup.map((markup) => ({ html: highlightMarkup(markup), message: mountedErrorMessage(markup) })),
);

const loop = new Wire.State("loop", 0);
const cycleReport = new Wire.State("cycleReport", "");

function makeCycle() {
	const stop = loop.listen((value) => loop.set(value + 1));
	try {
		loop.set(loop.get() + 1);
		Wire.flush();
		cycleReport.set("no error");
	} catch (error) {
		cycleReport.set(`${error.constructor.name}: ${error.message.slice(0, 60)}…`);
	} finally {
		stop();
	}
}
