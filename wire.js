function evalWithVariables(code, vars = {}) {
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

function parseAttribute(attrName, attrValue, allowedTypes, source) {
	let attr = {};
	if (attrValue.startsWith("@")) {
		const signal = Wire.controller.resolveSignal(attrValue.slice(1));
		attr = { type: "signal", signal, value: attrValue };
	} else if (attrValue.startsWith("{{")) {
		if (!attrValue.endsWith("}}")) throw new WireAttributeError("An argument starting with '{{' must end with '}}'");
		attr = { type: "expr", value: attrValue };
	} else if (attrValue == null || attrValue.length == 0) {
		attr = { type: "flag" };
	} else {
		attr = { type: "literal", value: attrValue };
	}
	if (!allowedTypes.includes(attr.type))
		throw new WireAttributeError(
			`Attribute '${attrName}' cannot be type '${attr.type}' with value '${attrValue}' on ${source} elements (allowed=${JSON.stringify(allowedTypes)})`,
		);
	return attr;
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
	static ALLOWED_ATTRIBUTES = {
		to: ["signal", "expr"],
		with: ["signal"],
		for: ["signal", "expr"],
		each: ["literal"],
		if: ["signal", "expr"],
		style: ["literal"],
		class: ["literal"],
	};

	constructor(el) {
		this.el = el;
		this.attributes = {};
		this.signalUnsubs = [];
		this.template = null;

		// Extract and validate attributes
		for (const attrName of this.el.getAttributeNames()) {
			if (!Object.hasOwn(WireElement.ALLOWED_ATTRIBUTES, attrName)) {
				throw new WireAttributeError(`<wire> element not allowed attribute '${attrName}'`);
			}
			const allowedTypes = WireElement.ALLOWED_ATTRIBUTES[attrName];
			const attrValue = this.el.getAttribute(attrName);
			this.attributes[attrName] = parseAttribute(attrName, attrValue, allowedTypes, "<wire>");
		}

		const contentAttributes = ["for", "to"];
		const foundContentAttributes = contentAttributes.filter((a) => Object.hasOwn(this.attributes, a));
		if (foundContentAttributes.length > 1) {
			throw new WireAttributeError(`Content attributes ${contentAttributes} are mutually exclusive but found: ${foundContentAttributes}`);
		}

		if (Object.hasOwn(this.attributes, "each") && !Object.hasOwn(this.attributes, "for")) {
			throw new WireAttributeError(`Attribute 'each' requires 'for', found attributes: ${JSON.stringify(this.attributes)}`);
		}

		if (Object.hasOwn(this.attributes, "to") && this.el.innerHTML.length > 0) {
			throw new WireAttributeError(`Cannot use 'to' if element has HTML content`);
		}

		const foundSignalAttributes = Object.values(this.attributes).filter((a) => a.type == "signal");
		if (foundSignalAttributes.length == 0 && Object.hasOwn(this.attributes, "if")) {
			console.warn(`prefer against using 'if' unless you also reference a signal, found attributes: ${JSON.stringify(this.attributes)}`);
		}

		// Store HTML content as template if any attribute rerenders
		if (Object.hasOwn(this.attributes, "for") || Object.hasOwn(this.attributes, "with") || Object.hasOwn(this.attributes, "if")) {
			this.template = this.el.innerHTML;
			this.el.innerHTML = "";
		}

		// Subscribe each signal
		for (const attrName in this.attributes) {
			if (this.attributes[attrName].type === "signal") {
				const signal = this.attributes[attrName].signal;
				this.signalUnsubs.push(signal.listen(this.#render.bind(this)));
			}
		}

		this.#render();
	}

	dispose() {
		for (const unsub of this.signalUnsubs) unsub();
		this.signalUnsubs = [];
	}

	#render() {
		// Conditional rendering on if
		if (Object.hasOwn(this.attributes, "if")) {
			let toRender = Wire.controller.evaluateAttribute(this.attributes.if);
			if (!toRender) {
				this.el.style.display = "none";
				this.el.innerHTML = "";
				return;
			}
		}

		this.el.style = this.attributes.style?.value;

		// Directly render signal value
		if (Object.hasOwn(this.attributes, "to")) {
			this.el.innerHTML = Wire.controller.evaluateAttribute(this.attributes.to);
			Wire.controller.mountElements(this.el);
			return;
		}

		// Hydrate template for each item in list
		if (Object.hasOwn(this.attributes, "for")) {
			const list = Wire.controller.evaluateAttribute(this.attributes.for);
			this.el.innerHTML = list.reduce((acc, item) => {
				let values = Object.hasOwn(this.attributes, "each") ? { [this.attributes.each.value]: item } : {};
				return acc + Wire.controller.hydrateTemplate(this.template, values);
			}, "");
			Wire.controller.mountElements(this.el);
		}

		// Hydrate template
		else if (Object.hasOwn(this.attributes, "with")) {
			this.el.innerHTML = Wire.controller.hydrateTemplate(this.template);
			Wire.controller.mountElements(this.el);
		}
	}
}

class ComponentElement {
	static ALLOWED_ATTRIBUTES = {
		name: ["literal"],
		instance: ["flag"],
		style: ["literal"],
		class: ["literal"],
	};

	constructor(el) {
		this.el = el;
		this.attributes = {};
		this.argAttributes = {};
		this.signalUnsubs = [];
		this.isInstance = false;

		// Extract and validate attributes
		let argAttributeNames = [];
		for (const attrName of this.el.getAttributeNames()) {
			if (attrName.startsWith("arg:")) {
				argAttributeNames.push(attrName);
				continue;
			}

			if (!Object.hasOwn(ComponentElement.ALLOWED_ATTRIBUTES, attrName)) {
				throw new WireAttributeError(`<component> element not allowed attribute '${attrName}'`);
			}

			const allowedTypes = ComponentElement.ALLOWED_ATTRIBUTES[attrName];
			const attrValue = this.el.getAttribute(attrName);
			this.attributes[attrName] = parseAttribute(attrName, attrValue, allowedTypes, "<component>");
		}

		this.isInstance = Object.hasOwn(this.attributes, "instance");

		for (const attrName of argAttributeNames) {
			const allowedTypes = this.isInstance ? ["signal", "literal", "expr"] : ["flag"];
			const attrValue = this.el.getAttribute(attrName);
			const realAttrName = attrName.slice(4);
			this.argAttributes[realAttrName] = parseAttribute(attrName, attrValue, allowedTypes, "<component>");
		}

		if (!Object.hasOwn(this.attributes, "name")) {
			throw new WireAttributeError("Component element requires a 'name' attribute");
		}

		// If we are a template then register template and hide
		if (!this.isInstance) {
			Wire.controller.registerComponentTemplate(this.attributes.name.value, { template: this.el.innerHTML, args: Object.keys(this.argAttributes) });
			this.el.innerHTML = "";
			this.el.style.display = "none";
			return;
		}

		// Otherwise we are an instance, listen to signal attributes
		for (const argAttrName in this.argAttributes) {
			if (this.argAttributes[argAttrName].type == "signal") {
				const signal = this.argAttributes[argAttrName].signal;
				this.signalUnsubs.push(signal.listen(this.#render.bind(this)));
			}
		}

		this.#render();
	}

	dispose() {
		for (const unsub of this.signalUnsubs) unsub();
		this.signalUnsubs = [];
	}

	#render() {
		const componentTemplate = Wire.controller.resolveComponentTemplate(this.attributes.name.value);

		// Collect required arguments for the template
		const values = {};
		for (const arg of componentTemplate.args) {
			if (Object.hasOwn(this.argAttributes, arg)) {
				values[arg] = Wire.controller.evaluateAttribute(this.argAttributes[arg]);
			} else {
				values[arg] = null;
			}
		}

		// Hydrate and render template
		this.el.innerHTML = Wire.controller.hydrateTemplate(componentTemplate.template, values);
		Wire.controller.mountElements(this.el);
	}
}

class WireController {
	#signalDict = {};
	#componentTemplateDict = {};
	#compiledTemplateCache = new Map();
	#mountedElements = new WeakSet();
	#observer = null;

	constructor() {
		addEventListener("load", () => {
			this.mountElements(document);
			this.startCleanupObserver();
		});
	}

	startCleanupObserver() {
		// Track when any DOM mutation occurs
		this.#observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.removedNodes) {
					if (node.nodeType !== Node.ELEMENT_NODE) continue;

					// Dispose any mounted wire.js elements
					const allNodes = [node, ...(node.querySelectorAll?.("wire,component") ?? [])];
					for (const el of allNodes) {
						el.__wireInstance?.dispose();
					}
				}
			}
		});

		this.#observer.observe(document.body, { childList: true, subtree: true });
	}

	mountElements(parent) {
		// Grab all outermost wire.js children elements
		const elementRegistry = { wire: WireElement, component: ComponentElement };
		const elementSelector = Object.keys(elementRegistry).join(",");
		const allElements = [...parent.querySelectorAll(elementSelector)];
		const outermostElements = allElements.filter((el) => !allElements.some((other) => other !== el && other.contains(el)));

		// Mount each if they are not already mounted
		for (const el of outermostElements) {
			if (this.#mountedElements.has(el)) continue;
			this.#mountedElements.add(el);
			const instance = new elementRegistry[el.localName](el);
			el.__wireInstance = instance;
		}
	}

	registerSignal(name, signal) {
		if (Object.hasOwn(this.#signalDict, name)) throw new WireRegistrationError(`Signal '${name}' is already registered`);
		this.#signalDict[name] = signal;
	}

	resolveSignal(name) {
		if (!Object.hasOwn(this.#signalDict, name)) throw new WireRegistrationError(`Signal '${name}' is not registered`);
		return this.#signalDict[name];
	}

	registerComponentTemplate(name, component) {
		if (Object.hasOwn(this.#componentTemplateDict, name)) throw new WireRegistrationError(`Component '${name}' is already registered`);
		this.#componentTemplateDict[name] = component;
	}

	resolveComponentTemplate(name) {
		if (!Object.hasOwn(this.#componentTemplateDict, name)) throw new WireRegistrationError(`Component '${name}' is not registered`);
		return this.#componentTemplateDict[name];
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

	evaluateAttribute(attr) {
		if (attr.type == "signal") {
			return attr.signal.get();
		} else if (attr.type == "literal") {
			return attr.value;
		} else if (attr.type == "expr") {
			const content = attr.value.slice(2, attr.value.length - 2);
			return evalWithVariables(content);
		}
	}
}

window.Wire = {
	controller: new WireController(),
	State,
	Computed,
};
