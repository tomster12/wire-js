function evalWithVariables(code, vars) {
	const argNames = Object.keys(vars);
	const argValues = Object.values(vars);
	const fn = new Function(...argNames, `"use strict"; return (${code});`);
	return fn(...argValues);
}

function isEqualShallow(a, b) {
	// Shallow equality
	if (Object.is(a, b)) return true;

	if (typeof a !== "object" || typeof b !== "object" || !a || !b)
		return false;

	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;

	for (const k of aKeys) {
		if (!Object.is(a[k], b[k])) return false;
	}

	return true;
}

class WireHydrationError extends Error {}

class WireAttributeError extends Error {}

class Signal {
	constructor(name) {
		this.name = name;
		this.value = null;
		this.listeners = [];
		Wire.controller.registerSignal(name, this);
	}

	get() {
		return this.value;
	}

	listen(callback) {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== callback);
		};
	}
}

class State extends Signal {
	constructor(name, value) {
		super(name);
		this.set(value);
	}

	set(value) {
		if (isEqualShallow(this.value, value)) return;

		this.value = value;
		this.listeners.forEach((callback) => callback(this.value));
	}
}

class Computed extends Signal {
	constructor(name, dependencies, compute) {
		super(name);

		this.dependencies = dependencies;
		this.compute = compute;
		this.dependencyUnsubs = [];

		const dependencyCallback = this.#onDependencyChanged.bind(this);

		for (const signal of this.dependencies) {
			const unsub = signal.listen(dependencyCallback);
			this.dependencyUnsubs.push(unsub);
		}
		
		this.#onDependencyChanged();
	}

	destroy() {
		for (const unsub of this.dependencyUnsubs) {
			unsub();
		}
		this.dependencyUnsubs = [];
		this.listeners = [];
	}

	#onDependencyChanged() {
		
		const newValue = this.compute(...this.dependencies.map((dep) => dep.get()));

		if (isEqualShallow(this.value, newValue)) return;

		this.value = newValue;
		this.listeners.forEach((callback) => callback(this.value));
	}
}

class WireElement {
	static ALLOWED_ATTRIBUTES = ["to", "with", "for", "each", "style", "class"];

	constructor(el) {
		this.el = el;
		this.attributes = {};

		// Cleanup any existing attached element
		if (el.__wireInstance) el.__wireInstance.destroy();
		el.__wireInstance = this;

		// Extract and check attributes
		for (const attrName of this.el.getAttributeNames()) {
			if (!WireElement.ALLOWED_ATTRIBUTES.includes(attrName)) {
				throw new WireAttributeError(`Wire element not allowed attribute '${attrName}'`);
			}
			this.attributes[attrName] = this.el.getAttribute(attrName);
		}

		if (
			Object.hasOwn(this.attributes, "to") &&
			(Object.hasOwn(this.attributes, "with") || Object.hasOwn(this.attributes, "for") || Object.hasOwn(this.attributes, "each"))
		) {
			throw new WireAttributeError("Invalid Wire element attribute layout: ", this.attributes);
		}

		// Resolve signal we are listening to
		this.listenedSignal = null;
		if (Object.hasOwn(this.attributes, "to")) this.listenedSignal = Wire.controller.resolveSignal(this.attributes.to);
		else if (Object.hasOwn(this.attributes, "for")) this.listenedSignal = Wire.controller.resolveSignal(this.attributes.for);
		else if (Object.hasOwn(this.attributes, "with")) this.listenedSignal = Wire.controller.resolveSignal(this.attributes.with);

		if (!this.listenedSignal) {
			throw new WireAttributeError(`Could not resolve Wire element attribute signal: ${JSON.stringify(this.attributes)}`);
		}

		// Store template if needed
		if (Object.hasOwn(this.attributes, "for") || Object.hasOwn(this.attributes, "with")) {
			this.template = this.el.innerHTML;
		}

		// Listen to signal and render
		const renderCallback = this.#render.bind(this);
		this.listenedSignalUnsub = this.listenedSignal.listen(renderCallback);
		this.#render();
	}

	dispose() {
		if (this.listenedSignalUnsub) {
			this.listenedSignalUnsub();
			this.listenedSignalUnsub = null;
		}
	}

	#render() {
		this.el.style = this.attributes.style;

		// Directly render signal value
		if (Object.hasOwn(this.attributes, "to")) {
			this.el.innerHTML = this.listenedSignal.get();
		}

		// Hydrate and render template for each item in list
		else if (Object.hasOwn(this.attributes, "for")) {
			const list = this.listenedSignal.get();
			this.el.innerHTML = list.reduce((acc, item) => {
				let values = Object.hasOwn(this.attributes, "each") ? { [this.attributes.each]: item } : {};
				return acc + Wire.controller.hydrateTemplate(this.template, values);
			}, "");
		}

		// Hydrate and render template
		else if (Object.hasOwn(this.attributes, "with")) {
			this.el.innerHTML = Wire.controller.hydrateTemplate(this.template);
		}

		// Recursively rerender children
		Wire.controller.rerenderElement(this.el);
	}
}

class ComponentElement {
	static ALLOWED_ATTRIBUTES = ["name", "instance", "with", "style", "class"];

	constructor(el) {
		this.el = el;
		this.attributes = {};
		this.argAttributes = {};
		this.isInstance = false;

		// Cleanup any existing attached element
		if (el.__componentInstance) el.__componentInstance.destroy();
		el.__componentInstance = this;

		// Extract and check attributes
		for (const attrName of this.el.getAttributeNames()) {
			if (attrName.startsWith("arg:")) {
				this.argAttributes[attrName.slice(4)] = this.el.getAttribute(attrName);
				continue;
			}

			if (!ComponentElement.ALLOWED_ATTRIBUTES.includes(attrName)) {
				throw new WireAttributeError(`Component element not allowed attribute '${attrName}'`);
			}
			this.attributes[attrName] = this.el.getAttribute(attrName);
		}

		if (!Object.hasOwn(this.attributes, "name")) {
			throw new WireAttributeError("Component element requires a name attribute");
		}

		this.isInstance = Object.hasOwn(this.attributes, "instance");

		if (this.isInstance && Object.hasOwn(this.attributes, "with")) {
			throw new WireAttributeError("Component instances cannot have a with attribute");
		}

		// If we are an instance then render
		if (this.isInstance) {
			if (!Object.hasOwn(Wire.controller.componentDict, this.attributes.name)) {
				throw new WireAttributeError("Component element name does have not a registered template");
			}
			this.#render();
		}

		// If we are a template then register and delete
		else {
			Wire.controller.componentDict[this.attributes.name] = { template: this.el.innerHTML, args: this.argAttributes };
			this.el.style.display = "none";
		}
	}

	#render() {
		// Hydrate and render template
		const component = Wire.controller.componentDict[this.attributes.name];
		const values = {};
		for (const arg in this.argAttributes) {
			if (Object.hasOwn(component.args, arg)) {
				values[arg] = this.argAttributes[arg];
			}
		}

		this.el.innerHTML = Wire.controller.hydrateTemplate(component.template, values);

		// Recursively rerender children
		Wire.controller.rerenderElement(this.el);
	}
}

class WireController {
	signalDict = {};
	componentDict = {};
	templateCache = new Map();

	constructor() {
		addEventListener("load", (e) => {
			this.rerenderElement(document);
		});
	}

	rerenderElement(element) {
		const componentElements = Array.from(element.getElementsByTagName("component"));
		for (const el of componentElements) new ComponentElement(el);

		const wireElements = element.getElementsByTagName("wire");
		for (const el of wireElements) new WireElement(el);
	}

	registerSignal(name, signal) {
		this.signalDict[name] = signal;
	}

	resolveSignal(name) {
		return this.signalDict[name];
	}

	compileTemplate(template) {
		if (this.templateCache.has(template)) {
			return this.templateCache.get(template);
		}

		const parts = [];
		let i = 0;

		while (i < template.length) {
			const start = template.indexOf("{{", i);

			if (start === -1) {
				parts.push({ type: "text", value: template.slice(i) });
				break;
			}

			if (start > i) {
				parts.push({ type: "text", value: template.slice(i, start) });
			}

			const end = template.indexOf("}}", start);
			if (end === -1)
				throw new WireHydrationError("Missing closing }}");

			const code = template.slice(start + 2, end).trim();
			parts.push({ type: "expr", value: code });

			i = end + 2;
		}

		this.templateCache.set(template, parts);
		return parts;
	}

	hydrateTemplate(template, variables = {}) {
		const parts = this.compileTemplate(template);

		let result = "";

		for (const part of parts) {
			if (part.type === "text") {
				result += part.value;
			} else {
				result += evalWithVariables(part.value, variables);
			}
		}

		return result;
	}
}

window.Wire = {
	controller: new WireController(),
	State,
	Computed,
};
