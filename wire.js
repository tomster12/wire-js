function evalWithVariables(code, vars) {
	var varString = "";
	for (const key in vars) varString += `var ${key} = ${JSON.stringify(vars[key])};`;
	eval(varString);
	return eval(code);
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
	}
}

class State extends Signal {
	constructor(name, value) {
		super(name);
		this.set(value);
	}

	set(value) {
		this.value = value;
		this.listeners.forEach((callback) => callback(this.value));
	}
}

class Computed extends Signal {
	constructor(name, dependencies, compute) {
		super(name);
		this.dependencies = dependencies;
		this.compute = compute;
		const dependencyCallback = this.#onDependencyChanged.bind(this);
		this.dependencies.forEach((signal) => signal.listen(dependencyCallback));
		this.#onDependencyChanged();
	}

	#onDependencyChanged() {
		this.value = this.compute(...this.dependencies.map((dep) => dep.get()));
		this.listeners.forEach((callback) => callback(this.value));
	}
}

class WireElement {
	static ALLOWED_ATTRIBUTES = ["to", "with", "for", "each", "style", "class"];

	constructor(el) {
		this.el = el;
		this.attributes = {};

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
		this.listenedSignal.listen(renderCallback);
		this.#render();
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

	hydrateTemplate(template, variables = {}) {
		let hydrated = template;

		for (let i = 0; i < hydrated.length; i++) {
			if (hydrated[i] === "{") {
				if (i == hydrated.length - 1) throw new WireHydrationError("found single '{' at EOF");
				if (hydrated[i + 1] !== "{") continue;

				let end = hydrated.indexOf("}", i);
				if (end === -1) throw new WireHydrationError("could not find closing '}");
				if (end == i + 2) {
					throw new WireHydrationError("Empty code block in template");
				}
				if (end == hydrated.length - 1) throw new WireHydrationError("found single '}' at EOF");
				if (hydrated[end + 1] !== "}") throw new WireHydrationError("found single '}'");

				const code = hydrated.slice(i + 2, end);
				const result = evalWithVariables(code, variables);
				hydrated = hydrated.slice(0, i) + result + hydrated.slice(end + 2);
			}
		}

		return hydrated;
	}
}

window.Wire = {
	controller: new WireController(),
	State,
	Computed,
};
