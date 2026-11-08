(() => {
	"use strict";

	const PLAIN_HTML_ATTRIBUTES = ["class", "style"];
	const MAX_UPDATE_ROUNDS = 100;

	const evalFuncCache = new Map();

	let updateScheduled = false;
	const pendingUpdates = new Set();

	function evalWithVariables(code, vars = {}) {
		const argNames = Object.keys(vars);
		const cacheKey = `${argNames.join(",")}\u0000${code}`;
		let evalFunc = evalFuncCache.get(cacheKey);
		if (!evalFunc) {
			evalFunc = new Function(...argNames, `"use strict"; return (${code});`);
			evalFuncCache.set(cacheKey, evalFunc);
		}
		return evalFunc(...Object.values(vars));
	}

	function isEqualShallow(a, b) {
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

	function escapeExprForDom(value) {
		const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
		return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
	}

	function decodeDomForExpr(code) {
		const ENTITY_DECODES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
		return code.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITY_DECODES[entity]);
	}

	function isObjectLike(value) {
		return typeof value === "object" && value !== null;
	}

	function parseAttribute(attrName, attrValue, allowedTypes, source) {
		let attr = {};
		const tokens = attrValue.trim().split(/\s+/);
		if (allowedTypes.includes("signals") && attrValue.trim() && tokens.every((token) => token.startsWith("@") && !token.startsWith("@{"))) {
			const signals = tokens.map((token) => controller.resolveSignal(token.slice(1)));
			attr = { type: "signals", signals, value: attrValue };
		} else if (attrValue.startsWith("@{")) {
			if (!attrValue.endsWith("}")) throw new WireAttributeError("An argument starting with '@{' must end with '}'");
			attr = { type: "expr", code: attrValue.slice(2, -1), value: attrValue };
		} else if (attrValue.startsWith("@")) {
			const signal = controller.resolveSignal(attrValue.slice(1));
			attr = { type: "signal", signal, value: attrValue };
		} else if (attrValue.includes("{{")) {
			throw new WireAttributeError(`'{{ }}' is only for template text, found in attribute '${attrName}' on ${source} elements, use '@{ expr }' for an expression`);
		} else if (attrValue.length == 0) {
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

	function captureFocusRestorer(root) {
		// Rebuilding the children destroys the focused field, so put focus, typed text and caret back on its replacement
		const active = document.activeElement;
		if (!active || active === root || !root.contains(active)) return null;

		const path = [];
		for (let node = active; node !== root; node = node.parentNode) {
			path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
		}

		const saved = { tag: active.localName, id: active.id, name: active.getAttribute("name"), type: active.type, value: active.value, defaultValue: active.defaultValue, checked: active.checked, defaultChecked: active.defaultChecked };
		try {
			saved.selection = [active.selectionStart, active.selectionEnd, active.selectionDirection];
		} catch {
			saved.selection = null;
		}

		return () => {
			let node = root;
			for (const index of path) node = node?.childNodes[index];
			if (!node || node.localName !== saved.tag || node.id !== saved.id || node.getAttribute("name") !== saved.name || node.type !== saved.type) return;

			// Typed text is only restored when the new markup did not set a different value itself
			if (saved.value !== undefined && node.defaultValue === saved.defaultValue) node.value = saved.value;
			if (node.defaultChecked === saved.defaultChecked) node.checked = saved.checked;

			node.focus({ preventScroll: true });
			if (saved.selection?.[0] != null) {
				try {
					node.setSelectionRange(...saved.selection);
				} catch {
					// not a text field
				}
			}
		};
	}

	class WireHydrationError extends Error { }

	class WireAttributeError extends Error { }

	class WireRegistrationError extends Error { }

	class WireCycleError extends Error { }

	function scheduleUpdate(job) {
		pendingUpdates.add(job);
		if (updateScheduled) return;
		updateScheduled = true;
		queueMicrotask(runScheduledUpdates);
	}

	function runScheduledUpdates() {
		updateScheduled = false;
		let rounds = 0;
		while (pendingUpdates.size > 0) {
			if (++rounds > MAX_UPDATE_ROUNDS) {
				pendingUpdates.clear();
				throw new WireCycleError(`Updates did not settle after ${MAX_UPDATE_ROUNDS} rounds, a signal is probably being set from inside its own dependent`);
			}
			const jobs = [...pendingUpdates];
			pendingUpdates.clear();
			for (const job of jobs) {
				try {
					job.runUpdate();
				} catch (error) {
					console.error(error);
				}
			}
		}
	}

	function recordSignalVersions(signals) {
		return new Map(
			signals.map((signal) => {
				signal.recomputeIfStale?.();
				return [signal, signal.version];
			}),
		);
	}

	function anySignalChanged(lastSeenVersions) {
		for (const [signal, version] of lastSeenVersions) {
			signal.recomputeIfStale?.();
			if (signal.version !== version) return true;
		}
		return false;
	}

	class Signal {
		constructor(name) {
			this.name = name;
			this.value = undefined;
			this.version = 0;
			this.sameObjectSetAtVersion = 0;
			this.listeners = new Set();
			this.dependents = new Set();

			controller.registerSignal(name, this);
		}

		get subscriberCount() {
			return this.listeners.size + this.dependents.size;
		}

		get() {
			return this.value;
		}

		listen(callback) {
			const listener = (value) => callback(value);
			this.listeners.add(listener);
			this.onSubscriberCountChanged();
			return () => {
				this.listeners.delete(listener);
				this.onSubscriberCountChanged();
			};
		}

		addDependent(dependent) {
			this.dependents.add(dependent);
			this.onSubscriberCountChanged();
		}

		removeDependent(dependent) {
			this.dependents.delete(dependent);
			this.onSubscriberCountChanged();
		}

		onSubscriberCountChanged() { }

		notifySubscribers() {
			for (const listener of [...this.listeners]) listener(this.value);
			for (const dependent of [...this.dependents]) dependent.onDependencyChanged();
		}
	}

	class State extends Signal {
		constructor(name, value) {
			super(name);
			this.value = value;
		}

		set(value) {
			// The same object may have been mutated in place before being set again
			const sameReference = Object.is(this.value, value);
			if (sameReference ? !isObjectLike(value) : isEqualShallow(this.value, value)) return;

			this.value = value;
			this.version++;
			if (sameReference) this.sameObjectSetAtVersion = this.version;
			this.notifySubscribers();
		}

		update(fn) {
			this.set(fn(this.value));
		}
	}

	class Computed extends Signal {
		constructor(name, dependencies, compute) {
			super(name);
			this.dependencies = dependencies;
			this.compute = compute;
			this.lastSeenVersions = new Map();
			this.isStale = true;
			this.isSubscribedToDependencies = false;

			this.recomputeIfStale();
			this.lastNotifiedVersion = this.version;
		}

		get() {
			this.recomputeIfStale();
			return this.value;
		}

		listen(callback) {
			if (this.listeners.size === 0) {
				this.recomputeIfStale();
				this.lastNotifiedVersion = this.version;
			}
			return super.listen(callback);
		}

		recomputeIfStale() {
			// Without subscribers nothing invalidates us, so staleness is found by comparing dependency versions
			if (!this.isStale && (this.isSubscribedToDependencies || !anySignalChanged(this.lastSeenVersions))) return;
			this.recompute();
		}

		recompute() {
			const value = this.compute(...this.dependencies.map((dep) => dep.get()));
			this.lastSeenVersions = recordSignalVersions(this.dependencies);
			this.isStale = false;
			const sameReference = Object.is(this.value, value);
			if (sameReference ? !isObjectLike(value) : isEqualShallow(this.value, value)) return;

			this.value = value;
			this.version++;
			if (sameReference) this.sameObjectSetAtVersion = this.version;
		}

		onSubscriberCountChanged() {
			const shouldSubscribe = this.subscriberCount > 0;
			if (shouldSubscribe === this.isSubscribedToDependencies) return;

			if (shouldSubscribe) {
				this.recomputeIfStale();
				this.isSubscribedToDependencies = true;
				for (const dep of this.dependencies) dep.addDependent(this);
			} else {
				this.isSubscribedToDependencies = false;
				for (const dep of this.dependencies) dep.removeDependent(this);
			}
		}

		onDependencyChanged() {
			if (this.isStale) return;
			this.isStale = true;
			if (this.listeners.size > 0) scheduleUpdate(this);
			for (const dependent of [...this.dependents]) dependent.onDependencyChanged();
		}

		runUpdate() {
			this.recomputeIfStale();
			if (this.version === this.lastNotifiedVersion) return;

			this.lastNotifiedVersion = this.version;
			for (const listener of [...this.listeners]) listener(this.value);
		}

		dispose() {
			this.isSubscribedToDependencies = false;
			for (const dep of this.dependencies) dep.removeDependent(this);
			this.listeners.clear();
		}
	}

	class SignalWatcher {
		constructor(callback, signals) {
			this.callback = callback;
			this.signals = [...new Set(signals)];
			this.lastSeenVersions = new Map();
			this.disposed = false;

			for (const signal of this.signals) signal.addDependent(this);
			this.run();
		}

		onDependencyChanged() {
			if (!this.disposed) scheduleUpdate(this);
		}

		runUpdate() {
			if (!this.disposed && anySignalChanged(this.lastSeenVersions)) this.run();
		}

		run() {
			// A source set with the same object may have been mutated in place, so the output cannot be assumed unchanged
			const forceRebuild = this.signals.some((signal) => {
				signal.recomputeIfStale?.();
				return signal.sameObjectSetAtVersion > (this.lastSeenVersions.get(signal) ?? Infinity);
			});
			this.lastSeenVersions = recordSignalVersions(this.signals);
			this.callback(forceRebuild);
		}

		dispose() {
			this.disposed = true;
			for (const signal of this.signals) signal.removeDependent(this);
		}
	}

	class WireElement {
		static ALLOWED_ATTRIBUTES = {
			to: ["signal"],
			with: ["signals"],
			for: ["signal", "expr"],
			each: ["literal"],
			if: ["signal", "expr"],
			else: ["flag"],
			style: ["literal"],
			class: ["literal"],
		};

		constructor(el, scope) {
			this.el = el;
			this.scope = scope;
			this.attributes = {};
			this.template = null;
			this.lastRenderedChunks = null;
			this.baseDisplay = el.style.display;

			// Extract and validate attributes
			for (const attrName of this.el.getAttributeNames()) {
				if (!Object.hasOwn(WireElement.ALLOWED_ATTRIBUTES, attrName)) {
					throw new WireAttributeError(`<wire> element not allowed attribute '${attrName}'`);
				}
				const allowedTypes = WireElement.ALLOWED_ATTRIBUTES[attrName];
				const attrValue = this.el.getAttribute(attrName);
				this.attributes[attrName] = PLAIN_HTML_ATTRIBUTES.includes(attrName)
					? { type: "literal", value: attrValue }
					: parseAttribute(attrName, attrValue, allowedTypes, "<wire>");
			}

			const contentAttributes = ["for", "to"];
			const foundContentAttributes = contentAttributes.filter((a) => this.has(a));
			if (foundContentAttributes.length > 1) {
				throw new WireAttributeError(`Content attributes ${contentAttributes} are mutually exclusive but found: ${foundContentAttributes}`);
			}

			if (this.has("each") && !this.has("for")) {
				throw new WireAttributeError(`Attribute 'each' requires 'for', found attributes: ${JSON.stringify(this.attributes)}`);
			}

			if (this.has("to") && this.el.innerHTML.length > 0) {
				throw new WireAttributeError(`Cannot use 'to' if element has HTML content`);
			}

			if (this.has("else")) {
				const previous = this.el.previousElementSibling?.__wireInstance;
				if (!(previous instanceof WireElement) || !(previous.has("if") || previous.has("else"))) {
					throw new WireAttributeError(`Attribute 'else' requires the previous sibling to be a <wire> with 'if' or 'else'`);
				}
			}

			// The element's own content is the template
			if (!this.has("to")) {
				this.template = this.el.innerHTML;
				this.el.innerHTML = "";
			}

			if (this.has("if") && Object.keys(scope).length === 0 && this.watchedSignals().length === 0) {
				console.warn(`prefer against using 'if' unless you also reference a signal, found attributes: ${JSON.stringify(this.attributes)}`);
			}

			this.watcher = new SignalWatcher((forceRebuild) => this.render(forceRebuild), this.watchedSignals());
		}

		watchedSignals() {
			const own = [];
			for (const attrName of ["to", "for", "if"]) {
				if (this.has(attrName) && this.attributes[attrName].type === "signal") own.push(this.attributes[attrName].signal);
			}
			if (this.has("with")) own.push(...this.attributes.with.signals);
			const previous = this.has("else") ? this.el.previousElementSibling.__wireInstance.watchedSignals() : [];
			return [...own, ...previous];
		}

		has(attrName) {
			return Object.hasOwn(this.attributes, attrName);
		}

		dispose() {
			this.watcher.dispose();
		}

		isThisBranchSatisfied() {
			return this.has("if") ? Boolean(controller.evaluateAttribute(this.attributes.if, this.scope)) : true;
		}

		isPrevBranchSatisfied() {
			return this.el.previousElementSibling?.__wireInstance?.isThisOrPrevBranchSatisfied() ?? false;
		}

		isThisOrPrevBranchSatisfied() {
			return (this.has("else") && this.isPrevBranchSatisfied()) || this.isThisBranchSatisfied();
		}

		shouldBeVisible() {
			if (this.has("else") && this.isPrevBranchSatisfied()) return false;
			return this.isThisBranchSatisfied();
		}

		render(forceRebuild) {
			if (!this.shouldBeVisible()) {
				this.el.style.display = "none";
				controller.clearContent(this);
				return;
			}
			this.el.style.display = this.baseDisplay;

			if (this.has("to")) {
				const text = String(this.attributes.to.signal.get() ?? "");
				controller.setContent(this, [{ html: escapeExprForDom(text), scope: this.scope }], forceRebuild);
				return;
			}

			if (this.has("for")) {
				const items = Array.from(controller.evaluateAttribute(this.attributes.for, this.scope));
				const chunks = items.map((item) => {
					const scope = this.has("each") ? { ...this.scope, [this.attributes.each.value]: item } : this.scope;
					return { html: controller.hydrateTemplate(this.template, scope), scope, data: item };
				});
				controller.setContent(this, chunks, forceRebuild);
			} else {
				controller.setContent(this, [{ html: controller.hydrateTemplate(this.template, this.scope), scope: this.scope }], forceRebuild);
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

		constructor(el, scope) {
			this.el = el;
			this.scope = scope;
			this.attributes = {};
			this.argAttributes = {};
			this.watcher = null;
			this.lastRenderedChunks = null;
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
				this.attributes[attrName] = PLAIN_HTML_ATTRIBUTES.includes(attrName)
					? { type: "literal", value: attrValue }
					: parseAttribute(attrName, attrValue, allowedTypes, "<component>");
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
				controller.registerComponentTemplate(this.attributes.name.value, { template: this.el.innerHTML, args: Object.keys(this.argAttributes) });
				this.el.innerHTML = "";
				this.el.style.display = "none";
				return;
			}

			this.watcher = new SignalWatcher((forceRebuild) => this.render(forceRebuild), this.watchedSignals());
		}

		watchedSignals() {
			return Object.values(this.argAttributes)
				.filter((attr) => attr.type === "signal")
				.map((attr) => attr.signal);
		}

		dispose() {
			this.watcher?.dispose();
		}

		render(forceRebuild) {
			const componentTemplate = controller.resolveComponentTemplate(this.attributes.name.value);

			// Collect required arguments for the template
			const values = {};
			for (const arg of componentTemplate.args) {
				if (Object.hasOwn(this.argAttributes, arg)) {
					values[arg] = controller.evaluateAttribute(this.argAttributes[arg], this.scope);
				} else {
					values[arg] = null;
				}
			}

			controller.setContent(this, [{ html: controller.hydrateTemplate(componentTemplate.template, values), scope: values, data: values }], forceRebuild);
		}
	}

	class WireController {
		static elementRegistry = { wire: WireElement, component: ComponentElement };
		static elementSelector = Object.keys(WireController.elementRegistry).join(",");

		signalDict = {};
		componentTemplateDict = {};
		compiledTemplateCache = new Map();
		mountedElements = new WeakSet();
		observer = null;

		constructor() {
			const start = () => {
				this.mountElements(document);
				this.startCleanupObserver();
			};
			if (document.readyState === "complete") queueMicrotask(start);
			else addEventListener("load", start);
		}

		mountElements(parent, scope = {}) {
			// Grab all outermost wire.js children elements
			const allElements = [...parent.querySelectorAll(WireController.elementSelector)];
			const outermostElements = allElements.filter((el) => !allElements.some((other) => other !== el && other.contains(el)));

			// Mount each if they are not already mounted
			for (const el of outermostElements) {
				this.mountElement(el, scope);
			}
		}

		mountElement(element, scope = {}) {
			if (this.mountedElements.has(element)) return;
			this.mountedElements.add(element);
			element.__wireInstance = new WireController.elementRegistry[element.localName](element, scope);
		}

		setContent(owner, chunks, forceRebuild = false) {
			// Each chunk is parsed on its own so the elements inside it can be mounted with that chunk's scope
			const previous = owner.lastRenderedChunks;
			if (!forceRebuild && previous && previous.length === chunks.length && previous.every((p, i) => p.html === chunks[i].html && isEqualShallow(p.data, chunks[i].data))) return;

			const fragment = document.createDocumentFragment();
			for (const { html, scope } of chunks) {
				const template = document.createElement("template");
				template.innerHTML = html;
				this.mountElements(template.content, scope);
				fragment.append(template.content);
			}

			const restoreFocus = captureFocusRestorer(owner.el);
			this.disposeWithin(owner.el);
			owner.el.replaceChildren(fragment);
			restoreFocus?.();
			owner.lastRenderedChunks = chunks.map(({ html, data }) => ({ html, data }));
		}

		clearContent(owner) {
			owner.lastRenderedChunks = null;
			this.disposeWithin(owner.el);
			owner.el.replaceChildren();
		}

		disposeWithin(parent) {
			for (const el of parent.querySelectorAll(WireController.elementSelector)) {
				el.__wireInstance?.dispose();
			}
		}

		registerSignal(name, signal) {
			if (Object.hasOwn(this.signalDict, name)) throw new WireRegistrationError(`Signal '${name}' is already registered`);
			this.signalDict[name] = signal;
		}

		resolveSignal(name) {
			if (!Object.hasOwn(this.signalDict, name)) throw new WireRegistrationError(`Signal '${name}' is not registered`);
			return this.signalDict[name];
		}

		registerComponentTemplate(name, component) {
			if (Object.hasOwn(this.componentTemplateDict, name)) throw new WireRegistrationError(`Component '${name}' is already registered`);
			this.componentTemplateDict[name] = component;
		}

		resolveComponentTemplate(name) {
			if (!Object.hasOwn(this.componentTemplateDict, name)) throw new WireRegistrationError(`Component '${name}' is not registered`);
			return this.componentTemplateDict[name];
		}

		hydrateTemplate(template, scope = {}) {
			const templateParts = this.compileTemplate(template);

			let result = "";

			for (const part of templateParts) {
				if (part.type === "text") {
					result += part.value;
				} else {
					const value = evalWithVariables(part.value, scope);
					result += part.raw ? String(value ?? "") : escapeExprForDom(value);
				}
			}

			return result;
		}

		evaluateAttribute(attr, scope = {}) {
			if (attr.type == "signal") {
				return attr.signal.get();
			} else if (attr.type == "literal") {
				return attr.value;
			} else if (attr.type == "expr") {
				return evalWithVariables(attr.code, scope);
			}
		}

		startCleanupObserver() {
			// Track when any DOM mutation occurs
			this.observer = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					for (const node of mutation.removedNodes) {
						if (node.nodeType !== Node.ELEMENT_NODE) continue;

						// Dispose any mounted wire.js elements
						const allNodes = [node, ...(node.querySelectorAll?.(WireController.elementSelector) ?? [])];
						for (const el of allNodes) {
							el.__wireInstance?.dispose();
						}
					}
				}
			});

			this.observer.observe(document.body, { childList: true, subtree: true });
		}

		compileTemplate(template) {
			if (this.compiledTemplateCache.has(template)) {
				return this.compiledTemplateCache.get(template);
			}

			// Everything is substituted as plain text, except the content of a nested <wire> or <component>:
			// that element hydrates its own content later, with its own scope
			const wireTagPattern = /<(\/?)(?:wire|component)\b(?:\{\{[\s\S]*?\}\}|[^>"]|"[^"]*")*>/gi;
			const parts = [];
			let nestedDepth = 0;
			let compiledUpTo = 0;
			let nestedContentStart = 0;
			let match;

			while ((match = wireTagPattern.exec(template)) !== null) {
				if (match[1]) {
					if (nestedDepth > 0 && --nestedDepth === 0) {
						parts.push({ type: "text", value: template.slice(nestedContentStart, match.index) });
						compiledUpTo = match.index;
					}
					continue;
				}
				if (nestedDepth === 0) {
					const tagEnd = match.index + match[0].length;
					parts.push(...this.compileInterpolations(template.slice(compiledUpTo, tagEnd)));
					nestedContentStart = tagEnd;
				}
				nestedDepth++;
			}

			if (nestedDepth > 0) parts.push({ type: "text", value: template.slice(nestedContentStart) });
			else parts.push(...this.compileInterpolations(template.slice(compiledUpTo)));

			this.compiledTemplateCache.set(template, parts);
			return parts;
		}

		compileInterpolations(text) {
			const parts = [];
			let i = 0;

			while (i < text.length) {
				const start = text.indexOf("{{", i);
				if (start === -1) break;

				const raw = text.startsWith("{{{", start);
				const open = raw ? "{{{" : "{{";
				const close = raw ? "}}}" : "}}";

				const end = text.indexOf(close, start + open.length);
				if (end === -1) throw new WireHydrationError(`Missing closing ${close}`);

				if (start > i) parts.push({ type: "text", value: text.slice(i, start) });
				parts.push({ type: "expr", value: decodeDomForExpr(text.slice(start + open.length, end)).trim(), raw });

				i = end + close.length;
			}

			if (i < text.length) parts.push({ type: "text", value: text.slice(i) });
			return parts;
		}
	}

	const controller = new WireController();

	window.Wire = Object.freeze({
		Signal,
		State,
		Computed,
		flush: runScheduledUpdates,
		signalNames: () => Object.keys(controller.signalDict),
		controller: Object.freeze({
			mountElement: (element) => controller.mountElement(element),
			mountElements: (parent) => controller.mountElements(parent),
		}),
		errors: Object.freeze({ WireHydrationError, WireAttributeError, WireRegistrationError, WireCycleError }),
	});
})();
