function evalWithVariables(code, vars) {
	const argNames = Object.keys(vars);
	const argValues = Object.values(vars);
	const fn = new Function(...argNames, `"use strict"; return (${code});`);
	return fn(...argValues);
}

function isEqualShallow(a, b) {
	// Shallow equality
	if (Object.is(a, b)) return true;

	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;

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

class WireRegistrationError extends Error {}

class Signal {
	constructor(name) {
		this.name = name;
		this.value = undefined;
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

		for (const signal of this.dependencies) {
			const unsub = signal.listen(this.#recalculate.bind(this));
			this.dependencyUnsubs.push(unsub);
		}

		this.#recalculate();
	}

	dispose() {
		for (const unsub of this.dependencyUnsubs) unsub();
		this.dependencyUnsubs = [];
		this.listeners = [];
	}

	#recalculate() {
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
		this.attrSignals = {};
		this.attrSignalUnsubs = [];
		this.template = null;

		// Extract and check attributes
		for (const attrName of this.el.getAttributeNames()) {
			if (!WireElement.ALLOWED_ATTRIBUTES.includes(attrName)) {
				throw new WireAttributeError(`Wire element not allowed attribute '${attrName}'`);
			}
			this.attributes[attrName] = this.el.getAttribute(attrName);
		}
		const signalAttributes = ["to", "with", "for"];
		const foundSignalAttributes = signalAttributes.filter((a) => this.hasAttribute(a));
		if (foundSignalAttributes.length > 1) {
			throw new WireAttributeError(`Can only use at most 1 signal attributes (${signalAttributes}): ${JSON.stringify(this.attributes)}`);
		}
		if (this.hasAttribute("each") && (this.hasAttribute("to") || this.hasAttribute("with"))) {
			throw new WireAttributeError(`Cannot use 'each' with 'to' or 'with': ${JSON.stringify(this.attributes)}`);
		}

		// Store template if needed
		if (this.hasAttribute("for") || this.hasAttribute("with")) {
			this.template = this.el.innerHTML;
			this.el.innerHTML = "";
		}

		// Resolve attribute signal
		if (foundSignalAttributes.length == 1) {
			const attrName = foundSignalAttributes[0];
			const attrValue = this.attributes[attrName];
			if (!attrValue.startsWith("@")) {
				throw new WireAttributeError(`Attribute '${attrName}' must begin with @ to reference a signal`);
			}
			const signal = Wire.controller.resolveSignal(attrValue.slice(1));
			this.attrSignals[attrName] = signal;
			this.attrSignalUnsubs.push(signal.listen(this.#render.bind(this)));
		}

		this.#render();
	}

	hasAttribute(a) {
		return Object.hasOwn(this.attributes, a);
	}

	dispose() {
		for (const unsub of this.attrSignalUnsubs) unsub();
		this.attrSignalUnsubs = [];
	}

	#render() {
		this.el.style = this.attributes.style;

		// Directly render signal value
		if (this.hasAttribute("to")) {
			this.el.innerHTML = this.attrSignals.to.get();
		}

		// Hydrate and render template for each item in list
		else if (this.hasAttribute("for")) {
			const list = this.attrSignals.for.get();
			console.log("Hello");
			this.el.innerHTML = list.reduce((acc, item) => {
				let values = this.hasAttribute("each") ? { [this.attributes.each]: item } : {};
				console.log(values);
				return acc + Wire.controller.hydrateTemplate(this.template, values);
			}, "");
		}

		// Hydrate and render template
		else if (this.hasAttribute("with")) {
			this.el.innerHTML = Wire.controller.hydrateTemplate(this.template);
		}

		// Recursively rerender children
		Wire.controller.rerenderElement(this.el);
	}
}

class ComponentElement {
	static ALLOWED_ATTRIBUTES = ["name", "instance", "style", "class"];

	constructor(el) {
		this.el = el;
		this.attributes = {};
		this.argAttributes = {};
		this.argAttrSignals = {};
		this.argAttrUnsubs = [];
		this.isInstance = false;

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
		if (!this.hasAttribute("name")) {
			throw new WireAttributeError("Component element requires a 'name' attribute");
		}

		// If we are an instance
		this.isInstance = this.hasAttribute("instance");
		if (this.isInstance) {
			// Resolve arg attribute signals
			for (const argAttrName in this.argAttributes) {
				const argAttrValue = this.argAttributes[argAttrName];
				if (argAttrValue.startsWith("@")) {
					const signal = Wire.controller.resolveSignal(argAttrValue.slice(1));
					this.argAttrSignals[argAttrName] = signal;
					this.argAttrUnsubs.push(signal.listen(this.#render.bind(this)));
				}
			}

			// And render
			this.#render();
		}

		// If we are a template then register template and hide
		else {
			Wire.controller.registerComponent(this.attributes.name, { template: this.el.innerHTML, args: this.argAttributes });
			this.el.innerHTML = "";
			this.el.style.display = "none";
		}
	}

	hasAttribute(a) {
		return Object.hasOwn(this.attributes, a);
	}

	#render() {
		// Hydrate and render template
		const component = Wire.controller.resolveComponent(this.attributes.name);
		const values = {};
		for (const arg in component.args) {
			if (Object.hasOwn(this.argAttributes, arg)) {
				if (Object.hasOwn(this.argAttrSignals, arg)) {
					values[arg] = this.argAttrSignals[arg].get();
				} else {
					console.log(this.argAttributes[arg]);
					values[arg] = Wire.controller.hydrateTemplate(this.argAttributes[arg]);
				}
			} else {
				values[arg] = null;
			}
		}
		this.el.innerHTML = Wire.controller.hydrateTemplate(component.template, values);

		// Recursively rerender children
		Wire.controller.rerenderElement(this.el);
	}
}

class WireController {
	#signalDict = {};
	#componentDict = {};
	#compiledTemplateCache = new Map();

	constructor() {
		addEventListener("load", (e) => {
			this.rerenderElement(document);
		});
	}

	rerenderElement(element) {
		const wireElements = element.getElementsByTagName("wire");
		for (const el of wireElements) new WireElement(el);

		const componentElements = Array.from(element.getElementsByTagName("component"));
		for (const el of componentElements) new ComponentElement(el);
	}

	registerSignal(name, signal) {
		if (Object.hasOwn(this.#signalDict, name)) throw new WireRegistrationError(`Signal '${name}' is already registered`);
		this.#signalDict[name] = signal;
	}

	resolveSignal(name) {
		if (!Object.hasOwn(this.#signalDict, name)) throw new WireRegistrationError(`Signal '${name}' is not registered`);
		return this.#signalDict[name];
	}

	registerComponent(name, component) {
		if (Object.hasOwn(this.#componentDict, name)) throw new WireRegistrationError(`Component '${name}' is already registered`);
		this.#componentDict[name] = component;
	}

	resolveComponent(name) {
		if (!Object.hasOwn(this.#componentDict, name)) throw new WireRegistrationError(`Component '${name}' is not registered`);
		return this.#componentDict[name];
	}

	hydrateTemplate(template, variables = {}) {
		const templateParts = this.#compileTemplate(template);

		let result = "";

		for (const part of templateParts) {
			if (part.type === "text") {
				result += part.value;
			} else {
				result += evalWithVariables(part.value, variables);
			}
		}

		return result;
	}

	#compileTemplate(template) {
		if (this.#compiledTemplateCache.has(template)) {
			return this.#compiledTemplateCache.get(template);
		}

		let parts = [];
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
			if (end === -1) throw new WireHydrationError("Missing closing }}");

			const code = template.slice(start + 2, end).trim();
			parts.push({ type: "expr", value: code });

			i = end + 2;
		}

		this.#compiledTemplateCache.set(template, parts);
		return parts;
	}
}

window.Wire = {
	controller: new WireController(),
	State,
	Computed,
};
