//#region Configuration

const STORAGE_KEY = "wire-quote-builder";
const FREE_SHIPPING_FROM = 500;
const SHIPPING = { standard: 9.5, express: 25 };

const DISCOUNT_CODES = {
	SAVE10: { label: "10% off", rate: 0.1, minimum: 0, freeShipping: false },
	HALF: { label: "50% off, orders over 200 only", rate: 0.5, minimum: 200, freeShipping: false },
	FREESHIP: { label: "free shipping", rate: 0, minimum: 0, freeShipping: true },
};

const SAMPLE_ITEMS = [
	{ name: "Design workshop (day)", qty: 2, price: 850, taxable: true },
	{ name: "Brand guidelines PDF", qty: 1, price: 400, taxable: true },
	{ name: "Printed handbook", qty: 25, price: 12.4, taxable: false },
];

//#endregion

//#region Utilities

const roundToCents = (value) => Math.round(value * 100) / 100;
const sumOf = (items, getValue) => items.reduce((total, item) => total + getValue(item), 0);

function formatMoney(amount, currency) {
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function escapeText(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

//#endregion

//#region State

function loadSaved() {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? null;
	} catch {
		return null;
	}
}

const saved = loadSaved();
let nextItemId = 1;
const withId = (item) => ({ ...item, id: nextItemId++ });

const items = new Wire.State("items", (saved?.items ?? SAMPLE_ITEMS).map(withId));

const clientName = new Wire.State("clientName", saved?.clientName ?? "");

const currency = new Wire.State("currency", saved?.currency ?? "USD");

const taxRate = new Wire.State("taxRate", saved?.taxRate ?? 8);

const expressShipping = new Wire.State("expressShipping", saved?.expressShipping ?? false);

const discountCode = new Wire.State("discountCode", saved?.discountCode ?? "");

const savedAt = new Wire.State("savedAt", "");

const copyLabel = new Wire.State("copyLabel", "Copy quote JSON");

const pricedItems = new Wire.Computed("pricedItems", [items], (items) =>
	items.map((item, index) => {
		const problems = [];
		if (!item.name.trim()) problems.push(`Item ${index + 1} needs a description`);
		if (!(item.qty > 0)) problems.push(`Item ${index + 1} needs a quantity above zero`);
		if (item.price < 0) problems.push(`Item ${index + 1} has a negative price`);
		return { ...item, lineTotal: roundToCents(item.qty * item.price), problems };
	}),
);

const problems = new Wire.Computed("problems", [pricedItems], (items) => items.flatMap((item) => item.problems));

const hasProblems = new Wire.Computed("hasProblems", [problems], (problems) => problems.length > 0);

const hasProblemsOrEmpty = new Wire.Computed("hasProblemsOrEmpty", [hasProblems, pricedItems], (hasProblems, items) => hasProblems || items.length === 0);

const itemCountLabel = new Wire.Computed("itemCountLabel", [pricedItems], (items) => `${items.length} ${items.length === 1 ? "item" : "items"}`);

const subtotal = new Wire.Computed("subtotal", [pricedItems], (items) => roundToCents(sumOf(items, (item) => item.lineTotal)));

const discountState = new Wire.Computed("discountState",
	[discountCode, subtotal],
	(code, subtotal) => {
		// none | unknown | locked | applied. The rules live here and the markup only reads the result
		const trimmed = code.trim().toUpperCase();
		if (!trimmed) return { status: "none", code: "", rate: 0, freeShipping: false };
		const rule = DISCOUNT_CODES[trimmed];
		if (!rule) return { status: "unknown", code: trimmed, rate: 0, freeShipping: false };
		if (subtotal < rule.minimum) return { status: "locked", code: trimmed, rate: 0, freeShipping: false, missing: rule.minimum - subtotal };
		return { status: "applied", code: trimmed, label: rule.label, rate: rule.rate, freeShipping: rule.freeShipping };
	});

const discountAmount = new Wire.Computed("discountAmount",
	[subtotal, discountState],
	(subtotal, discount) => roundToCents(subtotal * discount.rate));

const shippingAmount = new Wire.Computed("shippingAmount",
	[subtotal, discountState, expressShipping],
	(subtotal, discount, express) => {
		if (subtotal === 0 || discount.freeShipping || subtotal >= FREE_SHIPPING_FROM) return 0;
		return express ? SHIPPING.express : SHIPPING.standard;
	});

const taxAmount = new Wire.Computed("taxAmount",
	[pricedItems, discountState, taxRate],
	(pricedItems, discountState, taxRate) => {
		// Only taxable lines count, and the discount reduces them proportionally
		const taxableBase = sumOf(pricedItems.filter((item) => item.taxable), (item) => item.lineTotal) * (1 - discountState.rate);
		return roundToCents(taxableBase * (taxRate / 100));
	});

const total = new Wire.Computed("total",
	[subtotal, discountAmount, shippingAmount, taxAmount],
	(subtotal, discount, shipping, tax) => roundToCents(subtotal - discount + shipping + tax));

const summaryRows = new Wire.Computed("summaryRows",
	[subtotal, discountAmount, discountState, shippingAmount, taxAmount, taxRate, total],
	(subtotal, discount, discountState, shipping, tax, taxRate, total) => {
		const rows = [{ label: "Subtotal", amount: subtotal, kind: "" }];
		if (discount > 0) rows.push({ label: `Discount (${discountState.code})`, amount: -discount, kind: "discount" });
		rows.push({ label: shipping === 0 ? "Shipping (free)" : "Shipping", amount: shipping, kind: "" });
		rows.push({ label: `Tax (${taxRate}%)`, amount: tax, kind: "" });
		rows.push({ label: "Total", amount: total, kind: "total" });
		return rows;
	});

const quoteJson = new Wire.Computed("quoteJson",
	[clientName, currency, pricedItems, discountState, total],
	(clientName, currency, priceItems, discountState, total) =>
		JSON.stringify(
			{
				client: clientName || null,
				currency,
				lines: priceItems.map(({ name, qty, price, lineTotal }) => ({ name, qty, price, lineTotal })),
				discount: discountState.status === "applied" ? discountState.code : null,
				total,
			},
			null,
			2
		));

// Everything that should survive a refresh, as one value
const persistedState = new Wire.Computed("persistedState",
	[items, clientName, currency, taxRate, expressShipping, discountCode],
	(items, clientName, currency, taxRate, expressShipping, discountCode) => ({
		items: items.map(({ name, qty, price, taxable }) => ({ name, qty, price, taxable })),
		clientName,
		currency,
		taxRate,
		expressShipping,
		discountCode,
	}));

//#endregion

//#region Side effects

// listen() runs once per batch, and only when the value really changed
persistedState.listen((state) => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		savedAt.set(new Date().toLocaleTimeString([], { hour12: false }));
	} catch {
		// storage unavailable, the quote just stays in memory
	}
});

//#endregion

//#region Actions

function discountMessageHtml(discount) {
	const code = `<b>${escapeText(discount.code)}</b>`;
	if (discount.status === "unknown") return `${code} is not a valid code.`;
	if (discount.status === "locked") return `${code} needs ${formatMoney(discount.missing, currency.get())} more in items.`;
	return `${code} applied: ${discount.label}.`;
}

function setField(id, field, rawValue) {
	const value = field === "qty" || field === "price" ? (rawValue === "" ? 0 : Number(rawValue)) : rawValue;
	items.update((list) => list.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
}

function addItem() {
	items.update((list) => [...list, withId({ name: "", qty: 1, price: 0, taxable: true })]);
}

function duplicateItem(id) {
	items.update((list) => list.flatMap((item) => (item.id === id ? [item, withId({ ...item })] : [item])));
}

function removeItem(id) {
	items.update((list) => list.filter((item) => item.id !== id));
}

function loadSample() {
	items.set(SAMPLE_ITEMS.map(withId));
}

function resetAll() {
	items.set([]);
	clientName.set("");
	discountCode.set("");
	expressShipping.set(false);
	taxRate.set(8);
}

async function copyQuote() {
	try {
		await navigator.clipboard.writeText(quoteJson.get());
		copyLabel.set("Copied ✔");
	} catch {
		copyLabel.set("Copy failed");
	}
	setTimeout(() => copyLabel.set("Copy quote JSON"), 1500);
}

//#endregion
