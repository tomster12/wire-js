// Prints the markup written inside each .live box. It runs before Wire mounts, so it is exactly what the page contains.
function fillSourceBlocks() {
	for (const block of document.querySelectorAll("pre[data-source-of]")) {
		const live = document.getElementById(block.dataset.sourceOf);

		// innerHTML escapes some characters and writes empty attributes as name="", undo both
		const decoder = document.createElement("textarea");
		decoder.innerHTML = live.innerHTML;
		const lines = decoder.value.replace(/ ([\w:-]+)=""/g, " $1").split("\n");

		while (lines.length && !lines[0].trim()) lines.shift();
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

		const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\t*/)[0].length);
		const commonIndent = Math.min(...indents);
		block.textContent = lines.map((line) => line.slice(commonIndent)).join("\n");
	}
}

// Signals and Computed chain
const count = new Wire.State("count", 0);
const double = new Wire.Computed("double", [count], (value) => value * 2);
const quadruple = new Wire.Computed("quadruple", [double], (value) => value * 2);

// listen
const listening = new Wire.State("listening", false);
const log = new Wire.State("log", []);
let stopListening = null;

function toggleListener() {
	if (stopListening) {
		stopListening();
		stopListening = null;
		listening.set(false);
		return;
	}
	stopListening = double.listen((value) => log.update((lines) => [`double is now ${value}`, ...lines].slice(0, 3)));
	listening.set(true);
}

// Batching and flush
let computeCalls = 0;
const batchValue = new Wire.State("batchValue", 0);
const batchSquared = new Wire.Computed("batchSquared", [batchValue], (value) => {
	computeCalls++;
	return value * value;
});
const flushReport = new Wire.State("flushReport", "");

function setThenFlush() {
	const target = document.getElementById("batch-value");
	batchValue.update((value) => value + 1);
	const before = target.textContent;
	Wire.flush();
	flushReport.set(`DOM before flush: ${before}, after: ${target.textContent}`);
}

// Equality
const point = new Wire.State("point", { x: 1, y: 2 });
const pointRuns = new Wire.State("pointRuns", 0);
const number = new Wire.State("number", 5);
const numberRuns = new Wire.State("numberRuns", 0);
point.listen(() => pointRuns.update((total) => total + 1));
number.listen(() => numberRuns.update((total) => total + 1));

const updateReport = new Wire.State("updateReport", "");

function updateWithoutReturn() {
	try {
		number.update((value) => {
			value + 1;
		});
	} catch (error) {
		updateReport.set(`${error.constructor.name}: ${error.message}`);
	}
}

// Escaping
const userText = new Wire.State("userText", "");
const trustedMarkup = "<b>bold</b> and <i>italic</i> from our own code";

// Events and bindings
const addedNames = new Wire.State("addedNames", ["ada"]);
const busy = new Wire.State("busy", false);
const fullName = new Wire.State("fullName", "Ada");
const age = new Wire.State("age", 36);
const subscribed = new Wire.State("subscribed", true);
const color = new Wire.State("color", "blue");
const volume = new Wire.State("volume", 30);
const notes = new Wire.State("notes", [
	{ id: 1, text: "first" },
	{ id: 2, text: "second" },
]);

// Expressions, conditions
const a = new Wire.State("a", 2);
const b = new Wire.State("b", 3);
const score = new Wire.State("score", 60);
const flag = new Wire.State("flag", true);

// Lists
const todos = new Wire.State("todos", [
	{ id: 1, title: "Write the docs", done: true, tags: ["docs", "writing"] },
	{ id: 2, title: "Ship it", done: false, tags: ["release"] },
	{ id: 3, title: "<b>not bold</b> {{ 1 + 1 }} @{ 1 + 1 }", done: false, tags: [] },
]);
const stars = new Wire.State("stars", 3);
const names = new Wire.State("names", ["ada", "grace", "alan", "barbara", "edsger"]);
const filter = new Wire.State("filter", "");

function toggleTodo(id) {
	todos.update((list) => list.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
}

function sortTodos(key) {
	todos.update((list) => [...list].sort((left, right) => String(left[key]).localeCompare(String(right[key]), undefined, { numeric: true })));
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

// Names
const shadowed = new Wire.State("shadowed", "the signal");
new Wire.State("hidden", "no JavaScript variable holds this signal");

// Focus and identity
const tick = new Wire.State("tick", Date.now());
const items = new Wire.State("items", [{ name: "unchanged output" }]);
const stableReport = new Wire.State("stableReport", "");
let firstStableElement = null;
setInterval(() => tick.set(Date.now()), 1000);

function checkStableElement() {
	const element = document.querySelector(".stable");
	firstStableElement ??= element;
	stableReport.set(element === firstStableElement ? "same element" : "rebuilt");
}

// Lifecycle
const panelOpen = new Wire.State("panelOpen", true);
const renderCount = new Wire.State("renderCount", 0);

function countRender() {
	renderCount.update((total) => total + 1);
	return "";
}

// Tables
const servers = new Wire.State("servers", [
	{ name: "alpha", cpu: 40 },
	{ name: "beta", cpu: 75 },
]);

function serverTable(list) {
	const text = (value) => new Option(value).innerHTML;
	const rows = list.map((server) => `<tr><td>${text(server.name)}</td><td>${server.cpu}%</td></tr>`).join("");
	return `<table><tr><th>server</th><th>cpu</th></tr>${rows}</table>`;
}

function randomiseServers() {
	servers.update((list) => list.map((server) => ({ ...server, cpu: Math.round(Math.random() * 100) })));
}

// Inserting wires from JavaScript
function insertWire() {
	const target = document.getElementById("insert-target");
	target.insertAdjacentHTML("beforeend", `<div><wire to="@count"></wire> (inserted)</div>`);
	Wire.mount(target);
}

// Errors
const errorTotal = new Wire.State("errorTotal", 0);

function mountedErrorMessage(markup) {
	const holder = document.createElement("div");
	holder.innerHTML = markup;
	const errorCountBefore = Wire.errors.length;
	Wire.mount(holder);
	return Wire.errors.length > errorCountBefore ? Wire.errors[errorCountBefore].message.slice(0, 120) : "no error";
}

const brokenMarkup = [
	'<wire banana="1"></wire>',
	'<wire with="plain text"></wire>',
	'<wire for="@items" to="@items"></wire>',
	'<wire each="x" with="@count"></wire>',
	'<wire to="@count">content</wire>',
	'<wire if="{{ true }}"></wire>',
	'<wire to="@ghost"></wire>',
	"<wire else></wire>",
	'<component instance name="nope"></component>',
	'<wire with="@count">{{ oops</wire>',
];
const validationResults = new Wire.State(
	"validationResults",
	brokenMarkup.map((markup) => ({ markup, message: mountedErrorMessage(markup) })),
);

// Cycles
const loopSource = new Wire.State("loopSource", 0);
const cycleReport = new Wire.State("cycleReport", "");

function makeCycle() {
	const stop = loopSource.listen((value) => loopSource.set(value + 1));
	try {
		loopSource.set(loopSource.get() + 1);
		Wire.flush();
		cycleReport.set("no error");
	} catch (error) {
		cycleReport.set(`${error.constructor.name}: ${error.message.slice(0, 60)}…`);
	} finally {
		stop();
	}
}
