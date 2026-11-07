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

//#region 1. State and listeners

class StateDemo {
	constructor() {
		this.count = new Wire.State("count", 0);
		this.countLog = new Wire.State("countLog", []);
		this.countLoggingOn = new Wire.State("countLoggingOn", false);
		this.removeLogListener = null;

		this.startLogging();
	}

	increment() {
		this.count.set(this.count.get() + 1);
	}

	decrement() {
		this.count.set(this.count.get() - 1);
	}

	reset() {
		this.count.set(0);
	}

	startLogging() {
		this.removeLogListener = this.count.listen((value) => {
			this.countLog.set([`listener received ${value}`, ...this.countLog.get()].slice(0, 4));
		});
		this.countLoggingOn.set(true);
	}

	stopLogging() {
		// listen() returns the function that removes the listener again
		this.removeLogListener();
		this.removeLogListener = null;
		this.countLoggingOn.set(false);
	}

	toggleLogging() {
		if (this.removeLogListener) this.stopLogging();
		else this.startLogging();
	}
}

//#endregion

//#region 2. Computed

class ComputedDemo {
	constructor() {
		this.rectangleWidth = new Wire.State("rectangleWidth", 8);
		this.rectangleHeight = new Wire.State("rectangleHeight", 5);

		const dimensions = [this.rectangleWidth, this.rectangleHeight];
		this.rectangleArea = new Wire.Computed("rectangleArea", dimensions, (width, height) => width * height);
		this.rectanglePerimeter = new Wire.Computed("rectanglePerimeter", dimensions, (width, height) => 2 * (width + height));
		this.rectangleShape = new Wire.Computed("rectangleShape", dimensions, (width, height) => {
			if (width === height) return "square";
			return width > height ? "landscape" : "portrait";
		});

		this.rectangleDescription = new Wire.Computed(
			"rectangleDescription",
			[this.rectangleShape, this.rectangleArea],
			(shape, area) => `A ${shape} rectangle covering ${area} square units.`,
		);

		this.rectangleSvg = new Wire.Computed("rectangleSvg", dimensions, (width, height) => {
			const scale = 12;
			return `<svg width="${20 * scale}" height="${20 * scale}" viewBox="0 0 20 20"><rect class="shape" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}"/></svg>`;
		});
	}

	setWidth(value) {
		this.rectangleWidth.set(value);
	}

	setHeight(value) {
		this.rectangleHeight.set(value);
	}
}

//#endregion

//#region 3. Shallow equality

class EqualityDemo {
	constructor() {
		this.point = new Wire.State("point", { x: 1, y: 2 });
		this.pointNotifications = new Wire.State("pointNotifications", 0);

		this.point.listen(() => this.pointNotifications.set(this.pointNotifications.get() + 1));
	}

	setEqualCopy() {
		this.point.set({ ...this.point.get() });
	}

	setChangedCopy() {
		this.point.set({ ...this.point.get(), x: this.point.get().x + 1 });
	}

	mutateInPlace() {
		const current = this.point.get();
		current.x += 1;
		this.point.set(current);
	}
}

//#endregion

//#region 4. to

class ToDemo {
	constructor() {
		this.pageLoadedAt = Date.now();
		this.clock = new Wire.State("clock", this.pageLoadedAt);
		this.clockText = new Wire.Computed("clockText", [this.clock], (milliseconds) => new Date(milliseconds).toLocaleTimeString());

		setInterval(() => this.clock.set(Date.now()), 1000);
	}

	describeUptime() {
		const seconds = Math.floor((this.clock.get() - this.pageLoadedAt) / 1000);
		return `${seconds} seconds since the page loaded`;
	}
}

//#endregion

//#region 5. with

class WithDemo {
	constructor() {
		this.temperature = new Wire.State("temperature", 18);
	}

	describeTemperature(celsius) {
		if (celsius <= 0) return "Freezing.";
		if (celsius < 15) return "Cold.";
		if (celsius < 26) return "Mild.";
		return "Hot.";
	}
}

//#endregion

//#region 6. if

class IfDemo {
	constructor() {
		this.bannerVisible = new Wire.State("bannerVisible", true);
		this.bannerText = new Wire.State("bannerText", "I only exist while bannerVisible is truthy.");
	}

	toggleBanner() {
		this.bannerVisible.set(!this.bannerVisible.get());
	}
}

//#endregion

//#region 7. for and each

class ForDemo {
	constructor() {
		this.planets = new Wire.State("planets", [
			{ name: "Mercury", moons: 0, diameterKm: 4879 },
			{ name: "Venus", moons: 0, diameterKm: 12104 },
			{ name: "Earth", moons: 1, diameterKm: 12742 },
			{ name: "Mars", moons: 2, diameterKm: 6779 },
			{ name: "Jupiter", moons: 95, diameterKm: 139820 },
			{ name: "Saturn", moons: 146, diameterKm: 116460 },
		]);

		this.fruits = ["apple", "apricot", "banana", "blackberry", "cherry", "date", "fig", "grape", "lemon", "lime", "mango", "peach", "pear", "plum"];
		this.filterText = new Wire.State("filterText", "");
		this.stars = new Wire.State("stars", 3);
	}

	sortPlanetsBy(key) {
		const compare = (a, b) => (typeof a[key] === "string" ? a[key].localeCompare(b[key]) : b[key] - a[key]);
		this.planets.set([...this.planets.get()].sort(compare));
	}

	matchingFruits() {
		const query = this.filterText.get().toLowerCase();
		return this.fruits.filter((fruit) => fruit.includes(query));
	}
}

//#endregion

//#region 8. Components

class ComponentsDemo {
	constructor() {
		this.username = new Wire.State("username", "Ada Lovelace");
	}

	initialsOf(fullName) {
		return fullName
			.split(" ")
			.filter((word) => word.length > 0)
			.map((word) => word[0].toUpperCase())
			.slice(0, 2)
			.join("");
	}

	roleOfTheDay() {
		return ["Editor", "Reviewer", "Maintainer"][new Date().getDay() % 3];
	}
}

//#endregion

//#region 9. A poll: everything together

class PollDemo {
	constructor() {
		this.pollOptions = new Wire.State("pollOptions", [
			{ id: "performance", label: "Performance", votes: 12 },
			{ id: "documentation", label: "Documentation", votes: 7 },
			{ id: "accessibility", label: "Accessibility", votes: 9 },
			{ id: "features", label: "New features", votes: 4 },
		]);

		this.pollTotal = new Wire.Computed("pollTotal", [this.pollOptions], (options) => this.#sumVotes(options));

		this.pollRows = new Wire.Computed("pollRows", [this.pollOptions], (options) => {
			const total = this.#sumVotes(options);
			const leaderVotes = Math.max(...options.map((option) => option.votes));
			return options.map((option) => ({
				...option,
				percent: total ? Math.round((option.votes / total) * 100) : 0,
				isLeader: total > 0 && option.votes === leaderVotes,
			}));
		});

		this.pollSummary = new Wire.Computed("pollSummary", [this.pollRows], (rows) => {
			const leader = rows.find((row) => row.isLeader);
			return leader ? `${leader.label} leads with ${leader.percent}% of ${this.#sumVotes(rows)} votes.` : "";
		});
	}

	#sumVotes(options) {
		return options.reduce((total, option) => total + option.votes, 0);
	}

	castVote(optionId) {
		this.pollOptions.set(this.pollOptions.get().map((option) => (option.id === optionId ? { ...option, votes: option.votes + 1 } : option)));
	}

	castRandomVotes(amount) {
		let options = this.pollOptions.get();
		for (let i = 0; i < amount; i++) {
			const chosen = options[Math.floor(Math.random() * options.length)];
			options = options.map((option) => (option === chosen ? { ...option, votes: option.votes + 1 } : option));
		}
		this.pollOptions.set(options);
	}

	reset() {
		this.pollOptions.set(this.pollOptions.get().map((option) => ({ ...option, votes: 0 })));
	}
}

//#endregion

//#region 10. Lifecycle

class LifecycleDemo {
	constructor(observedSignal) {
		this.observedSignal = observedSignal;
		this.panelMounted = new Wire.State("panelMounted", true);
	}

	togglePanel() {
		this.panelMounted.set(!this.panelMounted.get());
	}

	observedListenerCount() {
		return this.observedSignal.listeners.length;
	}
}

//#endregion

//#region 11. Validation errors

class ValidationDemo {
	constructor() {
		this.scratch = new Wire.State("scratch", 0);
		this.errorResults = new Wire.State("errorResults", {});

		this.cases = [
			this.#markupCase("Attribute that does not exist", '<wire banana="1"></wire>'),
			this.#markupCase("Wrong value type for an attribute", '<wire with="plain text"></wire>'),
			this.#markupCase("Content attributes that exclude each other", '<wire for="@scratch" to="@scratch"></wire>'),
			this.#markupCase("each without for", '<wire each="item" with="@scratch"></wire>'),
			this.#markupCase("to on an element that has content", '<wire to="@scratch">hello</wire>'),
			this.#markupCase("Expression that is never closed", '<wire to="{{ 1 + 1"></wire>'),
			this.#markupCase("Signal that was never registered", '<wire to="@ghost"></wire>'),
			{ title: "Signal name registered twice", code: 'new Wire.State("scratch", 0)', run: () => new Wire.State("scratch", 0) },
			this.#markupCase("Component instance without a name", "<component instance></component>"),
			this.#markupCase("Component that was never defined", '<component instance name="nope"></component>'),
			this.#markupCase("Instance argument with no value", '<component instance name="avatar" arg:name></component>'),
			this.#markupCase("Template with an unclosed expression", '<wire with="@scratch">{{ oops</wire>'),
			this.#markupCase("Expression that throws", '<wire to="{{ missingVariable.x }}"></wire>'),
		];

		this.errorCaseRows = new Wire.Computed("errorCaseRows", [this.errorResults], (results) =>
			this.cases.map((errorCase, index) => ({
				index,
				title: errorCase.title,
				code: this.#escapeHtml(errorCase.code),
				hasRun: index in results,
				result: index in results ? this.#escapeHtml(results[index]) : "Not run yet",
			})),
		);
	}

	#markupCase(title, markup) {
		return { title, code: markup, run: () => this.#mountMarkup(markup) };
	}

	#mountMarkup(markup) {
		// The element is never added to the page, so nothing visible is affected
		const holder = document.createElement("div");
		holder.innerHTML = markup;
		controller.mountElement(holder.firstElementChild);
	}

	#escapeHtml(text) {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	runCase(index) {
		let result = "No error was thrown";
		try {
			this.cases[index].run();
		} catch (error) {
			const message = error.message.length > 170 ? `${error.message.slice(0, 170)}…` : error.message;
			result = `${error.constructor.name}: ${message}`;
		}
		this.errorResults.set({ ...this.errorResults.get(), [index]: result });
	}
}

//#endregion

const stateDemo = new StateDemo();
const computedDemo = new ComputedDemo();
const equalityDemo = new EqualityDemo();
const toDemo = new ToDemo();
const withDemo = new WithDemo();
const ifDemo = new IfDemo();
const forDemo = new ForDemo();
const componentsDemo = new ComponentsDemo();
const pollDemo = new PollDemo();
const lifecycleDemo = new LifecycleDemo(toDemo.clockText);
const validationDemo = new ValidationDemo();
