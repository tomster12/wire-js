//#region Showing the page's own source

function fillSourceBlocks() {
	// Runs before Wire mounts, so the markup read here is exactly what was written in the page
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

//#endregion

//#region 1. Signals

class SignalsDemo {
	constructor() {
		this.count = new Wire.State("count", 0);
		this.double = new Wire.Computed("double", [this.count], (value) => value * 2);
		this.quadruple = new Wire.Computed("quadruple", [this.double], (value) => value * 2);
		this.log = new Wire.State("log", []);
		this.loggingOn = new Wire.State("loggingOn", false);
		this.stopLogging = null;

		this.startLogging();
	}

	change(amount) {
		this.count.update((value) => value + amount);
	}

	startLogging() {
		this.stopLogging = this.count.listen((value) => this.log.update((lines) => [`listener received ${value}`, ...lines].slice(0, 3)));
		this.loggingOn.set(true);
	}

	toggleLogging() {
		if (this.stopLogging) {
			this.stopLogging();
			this.stopLogging = null;
			this.loggingOn.set(false);
		} else {
			this.startLogging();
		}
	}
}

//#endregion

//#region 2. Equality

class EqualityDemo {
	constructor() {
		this.point = new Wire.State("point", { x: 1, y: 2 });
		this.pointNotifications = new Wire.State("pointNotifications", 0);
		this.number = new Wire.State("number", 5);
		this.numberNotifications = new Wire.State("numberNotifications", 0);

		this.point.listen(() => this.pointNotifications.update((total) => total + 1));
		this.number.listen(() => this.numberNotifications.update((total) => total + 1));
	}

	setEqualCopy() {
		this.point.set({ ...this.point.get() });
	}

	setChangedCopy() {
		const point = this.point.get();
		this.point.set({ ...point, x: point.x + 1 });
	}

	mutateAndSetSameObject() {
		const point = this.point.get();
		point.x += 1;
		this.point.set(point);
	}

	setSameNumber() {
		this.number.set(5);
	}

	setNewNumber() {
		this.number.update((value) => value + 1);
	}
}

//#endregion

//#region 3. Batching and flush

class BatchDemo {
	constructor() {
		this.computeCalls = 0;
		this.value = new Wire.State("batchValue", 0);
		this.squared = new Wire.Computed("batchSquared", [this.value], (value) => {
			this.computeCalls++;
			return value * value;
		});
		this.report = new Wire.State("flushReport", "Not run yet");
	}

	setFiveTimes() {
		for (let i = 0; i < 5; i++) this.value.update((value) => value + 1);
	}

	readDomAfterSet() {
		const target = document.getElementById("batch-value");
		this.value.update((value) => value + 1);
		const before = target.textContent;
		Wire.flush();
		this.report.set(`DOM before flush: ${before}, after flush: ${target.textContent}`);
	}
}

//#endregion

//#region 4. Update cycles

class CycleDemo {
	constructor() {
		this.source = new Wire.State("loopSource", 0);
		this.mirror = new Wire.Computed("loopMirror", [this.source], (value) => value);
		this.result = new Wire.State("cycleResult", "Not run yet");
	}

	run() {
		const stop = this.mirror.listen((value) => this.source.set(value + 1));
		try {
			this.source.set(this.source.get() + 1);
			Wire.flush();
			this.result.set("No error was thrown");
		} catch (error) {
			this.result.set(`${error.constructor.name}: ${error.message}`);
		} finally {
			stop();
		}
	}
}

//#endregion

//#region 5. Escaping

class EscapingDemo {
	constructor() {
		this.samples = new Wire.State("samples", [
			{ index: 0, label: "markup", text: "<b>bold?</b> <script>alert(1)</script>" },
			{ index: 1, label: "template syntax", text: "{{ 1 + 1 }} and {{{ 1 + 1 }}}" },
			{ index: 2, label: "attribute syntax", text: "@{ 1 + 1 } and @count" },
			{ index: 3, label: "entities", text: "Fish &amp; chips &lt;3" },
		]);
		this.userText = new Wire.State("userText", this.samples.get()[0].text);
		this.trustedMarkup = "<b>bold</b> and <i>italic</i>, built by our own code";
	}

	pick(index) {
		this.userText.set(this.samples.get()[index].text);
	}
}

//#endregion

//#region 6. Expressions

class ExpressionsDemo {
	constructor() {
		this.a = new Wire.State("a", 2);
		this.b = new Wire.State("b", 3);
		this.loadedAt = new Date().toLocaleTimeString();
	}
}

//#endregion

//#region 7. Conditions

class ConditionDemo {
	constructor() {
		this.score = new Wire.State("score", 50);
		this.flag = new Wire.State("flag", true);
	}
}

//#endregion

//#region 8. Lists

class ListDemo {
	constructor() {
		this.todos = new Wire.State("todos", [
			{ id: 1, title: "Write the docs", done: true, tags: ["docs", "writing"] },
			{ id: 2, title: "Ship it", done: false, tags: ["release"] },
			{ id: 3, title: "<b>not bold</b> {{ 1 + 1 }} @{ 1 + 1 }", done: false, tags: [] },
		]);
		this.stars = new Wire.State("stars", 3);
	}

	toggle(id) {
		this.todos.set(this.todos.get().map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
	}

	sortBy(key) {
		const compare = (a, b) => (typeof a[key] === "string" ? a[key].localeCompare(b[key]) : Number(a[key]) - Number(b[key]));
		this.todos.set([...this.todos.get()].sort(compare));
	}

	mutateInPlace() {
		const todos = this.todos.get();
		todos[0].done = !todos[0].done;
		this.todos.set(todos);
	}
}

//#endregion

//#region 9. Components

class ComponentsDemo {
	constructor() {
		this.userName = new Wire.State("userName", "Ada");
	}

	rename() {
		this.userName.set(this.userName.get() === "Ada" ? "Grace" : "Ada");
	}
}

//#endregion

//#region 10. Re-rendering and focus

class FocusDemo {
	constructor() {
		this.clock = new Wire.State("focusClock", Date.now());
		this.items = new Wire.State("focusItems", [{ name: "unchanged output" }]);
		this.sameElement = new Wire.State("sameElement", "waiting for the first tick");
		this.firstElement = null;

		setInterval(() => {
			this.clock.set(Date.now());
			this.checkElement();
		}, 1000);
	}

	clockText() {
		return new Date(this.clock.get()).toLocaleTimeString();
	}

	checkElement() {
		const element = document.querySelector("#live-focus .stable-item");
		if (!element) return;
		if (!this.firstElement) this.firstElement = element;
		this.sameElement.set(this.firstElement === element ? "yes, the same element as at the first tick" : "no, it was rebuilt");
	}

	setSameObject() {
		this.items.set(this.items.get());
	}
}

//#endregion

//#region 11. Lifecycle

class LifecycleDemo {
	constructor() {
		this.clock = new Wire.State("lifeClock", Date.now());
		this.clockText = new Wire.Computed("lifeClockText", [this.clock], (milliseconds) => new Date(milliseconds).toLocaleTimeString());
		this.panelMounted = new Wire.State("panelMounted", true);

		setInterval(() => this.clock.set(Date.now()), 1000);
	}

	toggle() {
		this.panelMounted.update((mounted) => !mounted);
	}
}

//#endregion

//#region 12. Validation errors

class ValidationDemo {
	constructor() {
		this.scratch = new Wire.State("scratch", 0);

		const cases = [
			this.#markupCase("Attribute that does not exist", '<wire banana="1"></wire>'),
			this.#markupCase("Wrong value type for an attribute", '<wire with="plain text"></wire>'),
			this.#markupCase("Content attributes that exclude each other", '<wire for="@scratch" to="@scratch"></wire>'),
			this.#markupCase("each without for", '<wire each="item" with="@scratch"></wire>'),
			this.#markupCase("to on an element that has content", '<wire to="@scratch">hello</wire>'),
			this.#markupCase("to with an expression", '<wire to="@{ 1 + 1 }"></wire>'),
			this.#markupCase("Expression that is never closed", '<wire if="@{ 1 + 1"></wire>'),
			this.#markupCase("Template braces in an attribute", '<wire if="{{ true }}"></wire>'),
			this.#markupCase("Signal that was never registered", '<wire to="@ghost"></wire>'),
			{ title: "Signal name registered twice", code: 'new Wire.State("scratch", 0)', run: () => new Wire.State("scratch", 0) },
			this.#markupCase("else without a preceding if", "<wire else></wire>"),
			this.#markupCase("Component instance without a name", "<component instance></component>"),
			this.#markupCase("Component that was never defined", '<component instance name="nope"></component>'),
			this.#markupCase("Instance argument with no value", '<component instance name="card" arg:title></component>'),
			this.#markupCase("Template with an unclosed expression", '<wire with="@scratch">{{ oops</wire>'),
			this.#markupCase("Expression that throws", '<wire if="@{ missingVariable.x }" with="@scratch"></wire>'),
		];

		this.results = new Wire.State(
			"validationResults",
			cases.map((validationCase) => ({ title: validationCase.title, code: validationCase.code, result: this.#outcomeOf(validationCase) })),
		);
	}

	#markupCase(title, markup) {
		return { title, code: markup, run: () => this.#mountMarkup(markup) };
	}

	#mountMarkup(markup) {
		// The element is never added to the page, so nothing visible is affected
		const holder = document.createElement("div");
		holder.innerHTML = markup;
		Wire.controller.mountElement(holder.firstElementChild);
	}

	#outcomeOf(validationCase) {
		try {
			validationCase.run();
			return "No error was thrown";
		} catch (error) {
			const message = error.message.length > 160 ? `${error.message.slice(0, 160)}…` : error.message;
			return `${error.constructor.name}: ${message}`;
		}
	}
}

//#endregion

const signalsDemo = new SignalsDemo();
const equalityDemo = new EqualityDemo();
const batchDemo = new BatchDemo();
const cycleDemo = new CycleDemo();
const escapingDemo = new EscapingDemo();
const expressionsDemo = new ExpressionsDemo();
const conditionDemo = new ConditionDemo();
const listDemo = new ListDemo();
const componentsDemo = new ComponentsDemo();
const focusDemo = new FocusDemo();
const lifecycleDemo = new LifecycleDemo();
const validationDemo = new ValidationDemo();
