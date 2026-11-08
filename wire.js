(() => {
	"use strict";

	const PLAIN_HTML_ATTRIBUTES = ["id", "class", "style", "title"];
	const PLAIN_HTML_ATTRIBUTE_PREFIXES = ["data-", "aria-"];
	const MAX_UPDATE_ROUNDS = 100;

	const signalsByName = new Map();
	const componentTemplatesByName = new Map();
	const compiledFunctionCache = new Map();
	const compiledTemplateCache = new Map();
	const mountedElements = new WeakSet();
	const pendingTasks = new Set();
	const errors = [];

	let updateScheduled = false;
	let unsnapshotableCount = 0;

	//#region Utility

	class WireError extends Error { }

	function isVariableName(text) {
		return /^[A-Za-z_$][\w$]*$/.test(text);
	}

	function kebabToCamelCase(text) {
		return text.replace(/-([a-z0-9])/g, (fullMatch, character) => character.toUpperCase());
	}

	function reportError(error) {
		errors.push(error);
		console.error(error);
	}

	function snapshotOf(value) {
		try {
			const json = JSON.stringify(value, (key, nestedValue) => {
				if (typeof nestedValue === "function" ||
					nestedValue instanceof Map ||
					nestedValue instanceof Set) {
					throw new TypeError("not representable as JSON");
				}
				return nestedValue;
			});
			return json ?? "";
		} catch {
			// Data that JSON cannot represent (functions, Maps, Sets, circular references) can never be proven unchanged
			return `unsnapshotable-${++unsnapshotableCount}`;
		}
	}

	function escapeHtml(value) {
		const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
		return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
	}

	function unescapeHtml(text) {
		const HTML_UNESCAPES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
		return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => HTML_UNESCAPES[entity]);
	}

	//#endregion

	//#region Batched Tasks

	function scheduleTasks(task) {
		pendingTasks.add(task);

		if (!updateScheduled) {
			updateScheduled = true;
			queueMicrotask(runScheduledTasks);
		}
	}

	function runScheduledTasks() {
		updateScheduled = false;
		let roundCount = 0;

		while (pendingTasks.size > 0) {
			if (++roundCount > MAX_UPDATE_ROUNDS) {
				pendingTasks.clear();
				throw new WireError(`Updates did not settle after ${MAX_UPDATE_ROUNDS} rounds, a signal is probably being set from inside its own dependent`);
			}
			const updaters = [...pendingTasks];
			pendingTasks.clear();

			for (const updater of updaters) {
				try {
					updater.runUpdate();
				} catch (error) {
					reportError(error);
				}
			}
		}
	}

	//#endregion

	//#region Signals

	class Signal {
		constructor(name) {
			if (!isVariableName(name)) throw new WireError(`Signal name '${name}' must be a valid JavaScript variable name`);
			if (signalsByName.has(name)) throw new WireError(`Signal '${name}' is already registered`);

			this.name = name;
			this.value = undefined;
			this.dependents = new Set();
			signalsByName.set(name, this);
		}

		get() {
			return this.value;
		}

		listen(callback) {
			// Runs once per batch with the latest value, and only if its JSON snapshot changed
			let lastSnapshot = snapshotOf(this.get());
			const listener = {
				onDependencyChanged: () => scheduleTasks(listener),
				runUpdate: () => {
					if (!this.dependents.has(listener)) return;

					const value = this.get();
					const snapshot = snapshotOf(value);
					if (snapshot === lastSnapshot) return;

					lastSnapshot = snapshot;
					callback(value);
				},
			};
			this.dependents.add(listener);
			return () => {
				this.dependents.delete(listener);
			};
		}

		notifyDependents() {
			for (const dependent of [...this.dependents]) dependent.onDependencyChanged();
		}
	}

	class State extends Signal {
		constructor(name, value) {
			super(name);
			this.value = value;
		}

		set(value) {
			// An object may have been mutated in place, so setting one always notifies
			const isPrimitive = typeof value !== "object" || value === null;
			if (isPrimitive && Object.is(this.value, value)) return;

			this.value = value;
			this.notifyDependents();
		}

		update(computeNextValue) {
			const nextValue = computeNextValue(this.value);
			if (nextValue === undefined) throw new TypeError(`update() on signal '${this.name}' must return the new value, use set(undefined) to store undefined`);
			this.set(nextValue);
		}
	}

	class Computed extends Signal {
		constructor(name, dependencies, computeValue) {
			super(name);
			this.dependencies = dependencies;
			this.computeValue = computeValue;
			this.isStale = true;

			for (const dependency of this.dependencies) dependency.dependents.add(this);
			this.get();
		}

		get() {
			if (this.isStale) {
				this.value = this.computeValue(...this.dependencies.map((dependency) => dependency.get()));
				this.isStale = false;
			}
			return this.value;
		}

		onDependencyChanged() {
			this.isStale = true;
			this.notifyDependents();
		}
	}

	//#endregion

	//#region Attributes

	function isPlainHtmlAttribute(attributeName) {
		return PLAIN_HTML_ATTRIBUTES.includes(attributeName) || PLAIN_HTML_ATTRIBUTE_PREFIXES.some((prefix) => attributeName.startsWith(prefix));
	}

	function resolveSignal(name) {
		if (!signalsByName.has(name)) throw new WireError(`Signal '${name}' is not registered`);
		return signalsByName.get(name);
	}

	function parseAttribute(attributeName, attributeValue, allowedTypes, sourceName) {
		let attribute = {};
		const tokens = attributeValue.trim().split(/\s+/);
		if (allowedTypes.includes("signals") && attributeValue.trim() && tokens.every((token) => token.startsWith("@") && !token.startsWith("@{"))) {
			const signals = tokens.map((token) => resolveSignal(token.slice(1)));
			attribute = { type: "signals", signals, value: attributeValue };
		} else if (attributeValue.startsWith("@{")) {
			if (!attributeValue.endsWith("}")) throw new WireError("An argument starting with '@{' must end with '}'");
			attribute = { type: "expr", code: attributeValue.slice(2, -1), value: attributeValue };
		} else if (attributeValue.startsWith("@")) {
			attribute = { type: "signal", signal: resolveSignal(attributeValue.slice(1)), value: attributeValue };
		} else if (attributeValue.includes("{{")) {
			throw new WireError(`'{{ }}' is only for template text, found in attribute '${attributeName}' on ${sourceName} elements, use '@{ expr }' for an expression`);
		} else if (attributeValue.length == 0) {
			attribute = { type: "flag" };
		} else {
			attribute = { type: "literal", value: attributeValue };
		}
		if (!allowedTypes.includes(attribute.type))
			throw new WireError(
				`Attribute '${attributeName}' cannot be type '${attribute.type}' with value '${attributeValue}' on ${sourceName} elements (allowed=${JSON.stringify(allowedTypes)})`,
			);
		return attribute;
	}

	function parseAttributes(element, attributeNames, allowedTypesByAttributeName, sourceName) {
		const attributes = {};
		for (const attributeName of attributeNames) {
			if (isPlainHtmlAttribute(attributeName)) continue;
			if (!Object.hasOwn(allowedTypesByAttributeName, attributeName)) {
				throw new WireError(`${sourceName} element not allowed attribute '${attributeName}'`);
			}
			attributes[attributeName] = parseAttribute(attributeName, element.getAttribute(attributeName), allowedTypesByAttributeName[attributeName], sourceName);
		}
		return attributes;
	}

	function evaluateAttribute(attribute, scope = {}) {
		if (attribute.type == "signal") {
			return attribute.signal.get();
		} else if (attribute.type == "literal") {
			return attribute.value;
		} else if (attribute.type == "expr") {
			return evaluateWithVariables(attribute.code, scope);
		}
	}

	//#endregion

	//#region Expressions and Templates

	function evaluateWithVariables(code, scope = {}, isStatements = false) {
		// Every signal is available by its name, and a loop variable or component argument of the same name wins
		const variables = { ...Object.fromEntries(signalsByName), ...scope };
		const argumentNames = Object.keys(variables);
		const cacheKey = `${isStatements}\u0000${argumentNames.join(",")}\u0000${code}`;
		let compiledFunction = compiledFunctionCache.get(cacheKey);
		if (!compiledFunction) {
			const body = isStatements ? code : `return (${code});`;
			compiledFunction = new Function(...argumentNames, `"use strict"; ${body}`);
			compiledFunctionCache.set(cacheKey, compiledFunction);
		}
		return compiledFunction(...Object.values(variables));
	}

	function hydrateTemplate(template, scope = {}) {
		let result = "";

		for (const part of parseTemplate(template)) {
			if (part.type === "text") {
				result += part.value;
			} else {
				const value = evaluateWithVariables(part.code, scope);
				result += part.isUnescaped ? String(value ?? "") : escapeHtml(value);
			}
		}

		return result;
	}

	function parseTemplate(template) {
		if (compiledTemplateCache.has(template)) {
			return compiledTemplateCache.get(template);
		}

		// Everything is substituted as plain text, except a nested <wire> or <component> as a whole:
		// that element hydrates its own content later, with its own scope
		const wireTagPattern = /<(\/?)(?:wire|component)(?![\w-])(?:[^>"]|"[^"]*")*>/gi;
		const parts = [];
		let nestedDepth = 0;
		let parsedUpTo = 0;
		let match;

		while ((match = wireTagPattern.exec(template)) !== null) {
			const isClosingTag = Boolean(match[1]);
			if (!isClosingTag) {
				if (nestedDepth === 0) {
					parts.push(...parseTemplateInterpolations(template.slice(parsedUpTo, match.index)));
					parsedUpTo = match.index;
				}
				nestedDepth++;
			} else if (nestedDepth > 0 && --nestedDepth === 0) {
				const tagEnd = match.index + match[0].length;
				parts.push({ type: "text", value: template.slice(parsedUpTo, tagEnd) });
				parsedUpTo = tagEnd;
			}
		}

		if (nestedDepth > 0) parts.push({ type: "text", value: template.slice(parsedUpTo) });
		else parts.push(...parseTemplateInterpolations(template.slice(parsedUpTo)));

		compiledTemplateCache.set(template, parts);
		return parts;
	}

	function parseTemplateInterpolations(text) {
		const parts = [];
		let scanPosition = 0;

		while (scanPosition < text.length) {
			const openingPosition = text.indexOf("{{", scanPosition);
			if (openingPosition === -1) break;

			const isUnescaped = text.startsWith("{{{", openingPosition);
			const openingDelimiter = isUnescaped ? "{{{" : "{{";
			const closingDelimiter = isUnescaped ? "}}}" : "}}";

			const closingPosition = text.indexOf(closingDelimiter, openingPosition + openingDelimiter.length);
			if (closingPosition === -1) throw new WireError(`Missing closing ${closingDelimiter}`);

			if (openingPosition > scanPosition) parts.push({ type: "text", value: text.slice(scanPosition, openingPosition) });
			const code = unescapeHtml(text.slice(openingPosition + openingDelimiter.length, closingPosition)).trim();
			parts.push({ type: "expr", code, isUnescaped });

			scanPosition = closingPosition + closingDelimiter.length;
		}

		if (scanPosition < text.length) parts.push({ type: "text", value: text.slice(scanPosition) });
		return parts;
	}

	//#endregion

	//#region Elements

	class ReactiveElement {
		constructor(element, scope) {
			this.element = element;
			this.scope = scope;
			this.lastRenderedKeys = null;
			this.watchedSignals = [];
		}

		watch(signals) {
			this.watchedSignals = signals;
			for (const signal of signals) signal.dependents.add(this);
			try {
				this.render();
			} catch (error) {
				this.dispose();
				throw error;
			}
		}

		onDependencyChanged() {
			scheduleTasks(this);
		}

		runUpdate() {
			// An element removed from the page stops listening the next time one of its signals changes
			if (!this.element.isConnected) {
				this.dispose();
				return;
			}

			this.render();
		}

		renderChunks(chunks) {
			// A snapshot of each chunk's tracked data is part of its key, so mutating an item in place changes the key
			const keys = chunks.map((chunk) => `${chunk.html}\u0000${snapshotOf(chunk.trackedData)}`);
			const isUnchanged = this.lastRenderedKeys && this.lastRenderedKeys.length === keys.length && this.lastRenderedKeys.every((key, index) => key === keys[index]);
			if (isUnchanged) return;

			replaceElementContent(this.element, chunks);
			this.lastRenderedKeys = keys;
		}

		dispose() {
			for (const signal of this.watchedSignals) signal.dependents.delete(this);
		}
	}

	class WireElement extends ReactiveElement {
		static ALLOWED_ATTRIBUTES = {
			to: ["signal"],
			with: ["signals"],
			for: ["signal", "expr"],
			each: ["literal"],
			if: ["signal", "expr"],
			else: ["flag"],
		};

		constructor(element, scope) {
			super(element, scope);
			this.template = null;
			this.baseDisplay = element.style.display;
			this.attributes = parseAttributes(element, element.getAttributeNames(), WireElement.ALLOWED_ATTRIBUTES, "<wire>");

			const contentAttributeNames = ["for", "to"];
			const foundContentAttributeNames = contentAttributeNames.filter((attributeName) => this.hasWireAttribute(attributeName));
			if (foundContentAttributeNames.length > 1) {
				throw new WireError(`Content attributes ${contentAttributeNames} are mutually exclusive but found: ${foundContentAttributeNames}`);
			}

			if (this.hasWireAttribute("each") && !this.hasWireAttribute("for")) {
				throw new WireError(`Attribute 'each' requires 'for', found attributes: ${JSON.stringify(Object.keys(this.attributes))}`);
			}

			if (this.hasWireAttribute("each") && !isVariableName(this.attributes.each.value)) {
				throw new WireError(`Attribute 'each' must be a valid JavaScript variable name, found '${this.attributes.each.value}'`);
			}

			if (this.hasWireAttribute("to") && this.element.innerHTML.length > 0) {
				throw new WireError(`Cannot use 'to' if element has HTML content`);
			}

			if (this.hasWireAttribute("else") && !this.getPreviousWireElement()?.isPartOfConditionChain()) {
				throw new WireError(`Attribute 'else' requires the previous sibling to be a <wire> with 'if' or 'else'`);
			}

			// The element's own content is the template
			if (!this.hasWireAttribute("to")) {
				this.template = this.element.innerHTML;
				this.element.innerHTML = "";
			}

			if (this.hasWireAttribute("if") && Object.keys(scope).length === 0 && this.getWatchedSignals().length === 0) {
				console.warn(`prefer against using 'if' unless you also reference a signal, found attributes: ${JSON.stringify(Object.keys(this.attributes))}`);
			}

			this.watch(this.getWatchedSignals());
		}

		hasWireAttribute(attributeName) {
			return Object.hasOwn(this.attributes, attributeName);
		}

		getPreviousWireElement() {
			const previousInstance = this.element.previousElementSibling?.__wireInstance;
			return previousInstance instanceof WireElement ? previousInstance : null;
		}

		isPartOfConditionChain() {
			return this.hasWireAttribute("if") || this.hasWireAttribute("else");
		}

		getWatchedSignals() {
			const ownSignals = [];
			for (const attributeName of ["to", "for", "if"]) {
				if (this.hasWireAttribute(attributeName) && this.attributes[attributeName].type === "signal") ownSignals.push(this.attributes[attributeName].signal);
			}
			if (this.hasWireAttribute("with")) ownSignals.push(...this.attributes.with.signals);

			const previousSignals = this.hasWireAttribute("else") ? this.getPreviousWireElement().getWatchedSignals() : [];
			return [...ownSignals, ...previousSignals];
		}

		isConditionMet() {
			return this.hasWireAttribute("if") ? Boolean(evaluateAttribute(this.attributes.if, this.scope)) : true;
		}

		isPreviousBranchTaken() {
			return this.hasWireAttribute("else") && (this.getPreviousWireElement()?.isBranchTaken() ?? false);
		}

		isBranchTaken() {
			return this.isPreviousBranchTaken() || this.isConditionMet();
		}

		render() {
			if (this.isPreviousBranchTaken() || !this.isConditionMet()) {
				this.element.style.display = "none";
				this.renderChunks([]);
				return;
			}
			this.element.style.display = this.baseDisplay;

			if (this.hasWireAttribute("to")) {
				const text = String(this.attributes.to.signal.get() ?? "");
				this.renderChunks([{ html: escapeHtml(text), scope: this.scope }]);
				return;
			}

			if (this.hasWireAttribute("for")) {
				const items = Array.from(evaluateAttribute(this.attributes.for, this.scope));
				const chunks = items.map((item) => {
					const itemScope = this.hasWireAttribute("each") ? { ...this.scope, [this.attributes.each.value]: item } : this.scope;
					return { html: hydrateTemplate(this.template, itemScope), scope: itemScope, trackedData: item };
				});
				this.renderChunks(chunks);
			} else {
				this.renderChunks([{ html: hydrateTemplate(this.template, this.scope), scope: this.scope }]);
			}
		}
	}

	class ComponentElement extends ReactiveElement {
		static ALLOWED_ATTRIBUTES = {
			name: ["literal"],
			instance: ["flag"],
		};

		constructor(element, scope) {
			super(element, scope);
			this.argumentAttributes = {};

			const attributeNames = this.element.getAttributeNames();
			const argumentAttributeNames = attributeNames.filter((attributeName) => attributeName.startsWith("arg:"));
			const ownAttributeNames = attributeNames.filter((attributeName) => !attributeName.startsWith("arg:"));
			this.attributes = parseAttributes(element, ownAttributeNames, ComponentElement.ALLOWED_ATTRIBUTES, "<component>");
			this.isInstance = Object.hasOwn(this.attributes, "instance");

			const allowedArgumentTypes = this.isInstance ? ["signal", "literal", "expr"] : ["flag"];
			for (const attributeName of argumentAttributeNames) {
				// HTML lowercases attribute names, so arg:user-name is how userName is written in markup
				const argumentName = kebabToCamelCase(attributeName.slice("arg:".length));
				if (!isVariableName(argumentName)) {
					throw new WireError(`Argument '${attributeName}' becomes '${argumentName}', which is not a valid JavaScript variable name`);
				}
				this.argumentAttributes[argumentName] = parseAttribute(attributeName, this.element.getAttribute(attributeName), allowedArgumentTypes, "<component>");
			}

			if (!Object.hasOwn(this.attributes, "name")) {
				throw new WireError("Component element requires a 'name' attribute");
			}

			if (!this.isInstance) {
				registerComponentTemplate(this.attributes.name.value, { template: this.element.innerHTML, argumentNames: Object.keys(this.argumentAttributes) });
				this.element.innerHTML = "";
				this.element.style.display = "none";
				return;
			}

			this.watch(this.getWatchedSignals());
		}

		getWatchedSignals() {
			return Object.values(this.argumentAttributes)
				.filter((attribute) => attribute.type === "signal")
				.map((attribute) => attribute.signal);
		}

		render() {
			const componentTemplate = resolveComponentTemplate(this.attributes.name.value);

			for (const argumentName of Object.keys(this.argumentAttributes)) {
				if (!componentTemplate.argumentNames.includes(argumentName)) {
					throw new WireError(`Component '${this.attributes.name.value}' has no argument '${argumentName}', it declares: ${componentTemplate.argumentNames.join(", ") || "none"}`);
				}
			}

			// Arguments the instance leaves out are null
			const argumentValues = {};
			for (const argumentName of componentTemplate.argumentNames) {
				argumentValues[argumentName] = Object.hasOwn(this.argumentAttributes, argumentName)
					? evaluateAttribute(this.argumentAttributes[argumentName], this.scope)
					: null;
			}

			this.renderChunks([{
				html: hydrateTemplate(componentTemplate.template, argumentValues),
				scope: argumentValues,
				trackedData: argumentValues,
			}]);
		}
	}

	class BoundElement extends ReactiveElement {
		constructor(element, scope) {
			super(element, scope);
			this.sourceName = `<${element.localName}>`;
			this.oneWayBindings = [];
			this.appliedClassNames = [];

			const watchedSignals = [];
			if (element.hasAttribute("with")) {
				watchedSignals.push(...parseAttribute("with", element.getAttribute("with"), ["signals"], this.sourceName).signals);
			}

			for (const attributeName of element.getAttributeNames()) {
				const attributeValue = element.getAttribute(attributeName);
				if (attributeName.startsWith("on:")) {
					this.listenForEvent(attributeName.slice("on:".length), parseAttribute(attributeName, attributeValue, ["expr"], this.sourceName));
				} else if (attributeName.startsWith("bind:")) {
					const signal = parseAttribute(attributeName, attributeValue, ["signal"], this.sourceName).signal;
					this.bindBothWays(attributeName.slice("bind:".length), signal);
					watchedSignals.push(signal);
				} else if (attributeName.startsWith(":")) {
					const attribute = parseAttribute(attributeName, attributeValue, ["signal", "expr"], this.sourceName);
					this.oneWayBindings.push({ name: attributeName.slice(1), attribute });
					if (attribute.type === "signal") watchedSignals.push(attribute.signal);
				}
			}

			this.watch(watchedSignals);
		}

		listenForEvent(eventName, attribute) {
			this.element.addEventListener(eventName, (event) => {
				try {
					evaluateWithVariables(attribute.code, { ...this.scope, event }, true);
				} catch (error) {
					reportError(error);
				}
			});
		}

		bindBothWays(name, signal) {
			if (name !== "value" && name !== "checked") throw new WireError(`bind: only supports value and checked, found 'bind:${name}'`);
			if (!(signal instanceof State)) throw new WireError(`bind:${name} needs a State, but '${signal.name}' is a Computed`);

			this.oneWayBindings.push({ name, attribute: { type: "signal", signal } });
			const isNumeric = this.element.type === "number" || this.element.type === "range";
			const eventName = name === "checked" || this.element.localName === "select" ? "change" : "input";
			this.element.addEventListener(eventName, () => {
				if (name === "checked") signal.set(this.element.checked);
				else if (isNumeric) signal.set(this.element.value === "" ? null : Number(this.element.value));
				// Option values are always strings, so a select keeps the type its signal currently has
				else if (this.element.localName === "select" && typeof signal.get() === "number" && this.element.value !== "" && !Number.isNaN(Number(this.element.value))) signal.set(Number(this.element.value));
				else signal.set(this.element.value);
			});
		}

		render() {
			for (const { name, attribute } of this.oneWayBindings) {
				this.applyBinding(name, evaluateAttribute(attribute, this.scope));
			}
		}

		applyBinding(name, value) {
			if (name === "value") {
				const text = value == null ? "" : String(value);
				// Typing "1." into a number field must not be rewritten to "1" while the numbers match
				const isSameNumber = (this.element.type === "number" || this.element.type === "range") && this.element.value !== "" && Number(this.element.value) === Number(value);
				if (this.element.value !== text && !isSameNumber) this.element.value = text;
			} else if (name === "checked" || name === "selected") {
				this.element[name] = Boolean(value);
			} else if (name === "class") {
				this.applyClassNames(value ? String(value).split(/\s+/).filter(Boolean) : []);
			} else if (value === false || value == null) {
				this.element.removeAttribute(name);
			} else {
				this.element.setAttribute(name, value === true ? "" : String(value));
			}
		}

		applyClassNames(classNames) {
			// Only the names this binding added are removed, so static classes survive
			this.element.classList.remove(...this.appliedClassNames);
			this.element.classList.add(...classNames);
			this.appliedClassNames = classNames;
		}
	}

	const elementClassesByTagName = { wire: WireElement, component: ComponentElement };
	const contentElementSelector = Object.keys(elementClassesByTagName).join(",");

	function registerComponentTemplate(name, componentTemplate) {
		if (componentTemplatesByName.has(name)) throw new WireError(`Component '${name}' is already registered`);
		componentTemplatesByName.set(name, componentTemplate);
	}

	function resolveComponentTemplate(name) {
		if (!componentTemplatesByName.has(name)) throw new WireError(`Component '${name}' is not registered`);
		return componentTemplatesByName.get(name);
	}

	//#endregion

	//#region Mounting

	function mountPage() {
		const errorCountBefore = errors.length;

		mountElements(document);

		const pageErrorCount = errors.length - errorCountBefore;
		if (pageErrorCount > 0) console.error(`Wire: ${pageErrorCount} element(s) failed to mount, see the errors above and Wire.errors`);
	}

	function mountElements(parent, scope = {}) {
		// A wire or component owns its content, so only the outermost ones mount here, the rest mount when their owner renders
		const contentElements = [...parent.querySelectorAll(contentElementSelector)];

		const outermostContentElements = contentElements.filter((element) =>
			!contentElements.some((other) => other !== element && other.contains(element)));

		const boundElements = [...parent.querySelectorAll("*")].filter(
			(element) => hasBindingAttributes(element) && !contentElements.some((contentElement) => contentElement.contains(element)),
		);

		// Definitions register first so an instance placed above its definition still finds it
		const definitions = outermostContentElements.filter(isComponentDefinition);
		const others = outermostContentElements.filter((element) => !isComponentDefinition(element));

		for (const element of [...definitions, ...others, ...boundElements]) {
			// One element failing must not stop the others
			try {
				mountElement(element, scope);
			} catch (error) {
				element.setAttribute("data-wire-error", error.message);
				reportError(error);
			}
		}
	}

	function mountElement(element, scope) {
		if (mountedElements.has(element)) return;
		mountedElements.add(element);
		element.__wireInstance = new (elementClassesByTagName[element.localName] ?? BoundElement)(element, scope);
	}

	function isComponentDefinition(element) {
		return element.localName === "component" && !element.hasAttribute("instance");
	}

	function hasBindingAttributes(element) {
		if (element.localName in elementClassesByTagName) return false;
		return element.getAttributeNames().some((name) => name.startsWith(":") || name.startsWith("on:") || name.startsWith("bind:"));
	}

	function disposeNestedElements(parent) {
		for (const nestedElement of parent.querySelectorAll("*")) {
			nestedElement.__wireInstance?.dispose();
		}
	}

	function replaceElementContent(element, chunks) {
		// Each chunk is parsed on its own so the elements inside it can be mounted with that chunk's scope
		const fragment = document.createDocumentFragment();
		for (const { html, scope } of chunks) {
			const template = document.createElement("template");
			template.innerHTML = html;
			mountElements(template.content, scope);
			fragment.append(template.content);
		}

		const restoreFocus = captureFocusRestorer(element);
		disposeNestedElements(element);
		element.replaceChildren(fragment);
		restoreFocus?.();
	}

	function captureFocusRestorer(rootElement) {
		// Rebuilding the children destroys the focused field, so put focus, typed text and caret back on its replacement
		const focusedElement = document.activeElement;
		if (!focusedElement || focusedElement === rootElement || !rootElement.contains(focusedElement)) return null;

		const childIndexPath = [];
		for (let node = focusedElement; node !== rootElement; node = node.parentNode) {
			childIndexPath.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
		}

		const saved = {
			tagName: focusedElement.localName,
			id: focusedElement.id,
			name: focusedElement.getAttribute("name"),
			type: focusedElement.type,
			value: focusedElement.value,
			defaultValue: focusedElement.defaultValue,
			checked: focusedElement.checked,
			defaultChecked: focusedElement.defaultChecked,
		};
		try {
			saved.selection = [focusedElement.selectionStart, focusedElement.selectionEnd, focusedElement.selectionDirection];
		} catch {
			saved.selection = null;
		}

		return () => {
			let replacement = rootElement;
			for (const childIndex of childIndexPath) replacement = replacement?.childNodes[childIndex];
			if (!replacement || replacement.localName !== saved.tagName || replacement.id !== saved.id || replacement.getAttribute("name") !== saved.name || replacement.type !== saved.type) return;

			// Typed text is only restored when the new markup did not set a different value itself
			if (saved.value !== undefined && replacement.defaultValue === saved.defaultValue) replacement.value = saved.value;
			if (replacement.defaultChecked === saved.defaultChecked) replacement.checked = saved.checked;

			replacement.focus({ preventScroll: true });
			if (saved.selection?.[0] != null) {
				try {
					replacement.setSelectionRange(...saved.selection);
				} catch {
					// not a text field
				}
			}
		};
	}

	//#endregion

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mountPage);
	}
	else {
		queueMicrotask(mountPage);
	}

	window.Wire = Object.freeze({
		State,
		Computed,
		WireError,
		errors,
		flush: runScheduledTasks,
		mount: (parent) => mountElements(parent),
	});
})();
