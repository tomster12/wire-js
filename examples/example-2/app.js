//#region Configuration

const TICK_INTERVAL_MS = 1000;
const SERVER_HISTORY_LENGTH = 40;
const FLEET_HISTORY_LENGTH = 60;
const TREND_WINDOW_TICKS = 10;

const REGION_NAMES = ["us-east", "us-west", "eu-west", "ap-south"];
const SERVER_NAMES = [
	"api-gateway", "auth", "billing", "search", "checkout", "inventory",
	"notifications", "analytics", "media-cdn", "recommender", "orders", "payments",
];

const MEMORY_THRESHOLDS = { warning: 75, critical: 90 };
const ERROR_THRESHOLDS = { warning: 2, critical: 5 };

const SEVERITY_RANK = { ok: 0, warning: 1, critical: 2 };
const SEVERITY_LABEL = { ok: "Healthy", warning: "Degraded", critical: "Critical" };

const STATUS_CHIPS = [{ key: "all", label: "All" }, ...Object.entries(SEVERITY_LABEL).map(([key, label]) => ({ key, label }))];

const SORTERS = {
	name: (a, b) => a.name.localeCompare(b.name),
	status: (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.cpuPercent - a.cpuPercent,
	cpu: (a, b) => b.cpuPercent - a.cpuPercent,
	latency: (a, b) => b.latencyMs - a.latencyMs,
	errors: (a, b) => b.errorPercent - a.errorPercent,
};

//#endregion

//#region Utilities

const randomBetween = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundToTenth = (value) => Math.round(value * 10) / 10;
const approach = (current, target, rate) => current + (target - current) * rate;
const sumOf = (items, getValue) => items.reduce((total, item) => total + getValue(item), 0);
const countSeverity = (servers, severity) => servers.filter((server) => server.severity === severity).length;
const averageCpu = (servers) => roundToTenth(sumOf(servers, (server) => server.cpuPercent) / servers.length);
const formatCount = (value) => Math.round(value).toLocaleString("en-US");

function severityOf(value, warningAt, criticalAt) {
	if (value >= criticalAt) return "critical";
	if (value >= warningAt) return "warning";
	return "ok";
}

//#endregion

//#region Server

class Server {
	static createRandom(name, index) {
		const baseline = {
			cpuPercent: randomBetween(22, 55),
			memoryPercent: randomBetween(35, 65),
			latencyMs: randomBetween(35, 110),
			requestsPerSecond: Math.round(randomBetween(150, 1800)),
		};
		return Object.assign(new Server(), {
			name,
			region: REGION_NAMES[index % REGION_NAMES.length],
			baseline,
			cpuPercent: roundToTenth(baseline.cpuPercent),
			memoryPercent: roundToTenth(baseline.memoryPercent),
			latencyMs: Math.round(baseline.latencyMs * (1 + baseline.cpuPercent / 80)),
			errorPercent: 0.1,
			requestsPerSecond: baseline.requestsPerSecond,
			incidentTicksLeft: 0,
			restartCount: 0,
			cpuHistory: [],
			latencyHistory: [],
		});
	}

	// Servers are immutable: every change makes a new instance
	copyWith(changes) {
		return Object.assign(new Server(), this, changes);
	}

	get statusLabel() {
		return SEVERITY_LABEL[this.severity];
	}

	// One simulated tick, standing in for a real websocket or polling feed
	next() {
		const { baseline } = this;
		let incidentTicksLeft = this.incidentTicksLeft;
		if (incidentTicksLeft === 0 && Math.random() < 0.012) incidentTicksLeft = Math.floor(randomBetween(8, 16));
		const underIncident = incidentTicksLeft > 0;

		const cpuPercent = clamp(approach(this.cpuPercent, underIncident ? 95 : baseline.cpuPercent, underIncident ? 0.35 : 0.12) + randomBetween(-4, 4), 2, 99);
		const memoryDrift = underIncident ? 0.8 : (baseline.memoryPercent - this.memoryPercent) * 0.1;
		const memoryPercent = clamp(this.memoryPercent + memoryDrift + randomBetween(-0.6, 0.6), 10, 98);
		const incidentLatency = underIncident ? randomBetween(80, 200) : 0;
		const latencyMs = clamp(baseline.latencyMs * (1 + cpuPercent / 80) + incidentLatency + randomBetween(-6, 6), 8, 900);
		const errorPercent = clamp(underIncident ? this.errorPercent + randomBetween(0.2, 1.1) : this.errorPercent * 0.7 + randomBetween(0, 0.15), 0, 20);
		const trafficNoise = baseline.requestsPerSecond * 0.04;
		const trafficLoss = underIncident ? baseline.requestsPerSecond * 0.03 : 0;
		const requestsPerSecond = Math.max(0, approach(this.requestsPerSecond, baseline.requestsPerSecond, 0.2) + randomBetween(-trafficNoise, trafficNoise) - trafficLoss);

		return this.copyWith({
			incidentTicksLeft: Math.max(0, incidentTicksLeft - 1),
			cpuPercent: roundToTenth(cpuPercent),
			memoryPercent: roundToTenth(memoryPercent),
			latencyMs: Math.round(latencyMs),
			errorPercent: roundToTenth(errorPercent),
			requestsPerSecond: Math.round(requestsPerSecond),
			cpuHistory: [...this.cpuHistory, roundToTenth(cpuPercent)].slice(-SERVER_HISTORY_LENGTH),
			latencyHistory: [...this.latencyHistory, Math.round(latencyMs)].slice(-SERVER_HISTORY_LENGTH),
		});
	}

	restarted() {
		return this.copyWith({
			cpuPercent: roundToTenth(this.baseline.cpuPercent),
			memoryPercent: roundToTenth(this.baseline.memoryPercent),
			errorPercent: 0,
			incidentTicksLeft: 0,
			restartCount: this.restartCount + 1,
		});
	}

	withIncident(ticks) {
		return this.copyWith({ incidentTicksLeft: ticks });
	}

	// Rates each metric against the thresholds, the overall severity is the worst of them
	assess(thresholds) {
		const cpuSeverity = severityOf(this.cpuPercent, thresholds.cpuWarning, thresholds.cpuCritical);
		const memorySeverity = severityOf(this.memoryPercent, MEMORY_THRESHOLDS.warning, MEMORY_THRESHOLDS.critical);
		const latencySeverity = severityOf(this.latencyMs, thresholds.latencyLimitMs, thresholds.latencyLimitMs * 2);
		const errorSeverity = severityOf(this.errorPercent, ERROR_THRESHOLDS.warning, ERROR_THRESHOLDS.critical);
		const severity = [cpuSeverity, memorySeverity, latencySeverity, errorSeverity].reduce((worst, current) => (SEVERITY_RANK[current] > SEVERITY_RANK[worst] ? current : worst));
		return this.copyWith({ cpuSeverity, memorySeverity, latencySeverity, errorSeverity, severity });
	}
}

//#endregion

//#region Charts

const GRID_GUIDES = [25, 50, 75].map((value) => ({ value, max: 100, kind: "grid" }));

// Guide lines, then each series as a line (optionally filled), right-aligned so new points scroll in from the right
function chartSvg({ width, height, pointCount, series, guides = [], className = "chart" }) {
	const xAt = (index) => ((index / (pointCount - 1)) * width).toFixed(1);
	const yAt = (value, max) => (height - clamp(value / max, 0, 1) * height).toFixed(1);
	let shapes = "";

	for (const guide of guides) {
		const y = yAt(guide.value, guide.max);
		shapes += `<line class="guide ${guide.kind}" x1="0" x2="${width}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`;
	}

	for (const line of series) {
		const offset = pointCount - line.data.length;
		const points = line.data.map((value, index) => `${xAt(index + offset)},${yAt(value, line.max)}`).join(" ");
		if (line.filled) shapes += `<polygon class="area ${line.kind}" points="${xAt(offset)},${height} ${points} ${width},${height}"/>`;
		shapes += `<polyline class="line ${line.kind}" points="${points}" vector-effect="non-scaling-stroke"/>`;
	}

	return `<svg class="${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${shapes}</svg>`;
}

const sparklineSvg = (server) =>
	chartSvg({ width: 100, height: 28, pointCount: SERVER_HISTORY_LENGTH, series: [{ data: server.cpuHistory, max: 100, kind: "primary" }], className: `sparkline ${server.severity}` });

const fleetChartSvg = (history, thresholds) =>
	chartSvg({
		width: 600,
		height: 160,
		pointCount: FLEET_HISTORY_LENGTH,
		guides: [...GRID_GUIDES, { value: thresholds.cpuWarning, max: 100, kind: "warning" }, { value: thresholds.cpuCritical, max: 100, kind: "critical" }],
		series: [{ data: history, max: 100, kind: "primary", filled: true }],
		className: "chart tall",
	});

const detailChartSvg = (server, thresholds) =>
	chartSvg({
		width: 300,
		height: 110,
		pointCount: SERVER_HISTORY_LENGTH,
		guides: [...GRID_GUIDES, { value: thresholds.cpuWarning, max: 100, kind: "warning" }],
		series: [
			{ data: server.latencyHistory, max: thresholds.latencyLimitMs * 3, kind: "secondary" },
			{ data: server.cpuHistory, max: 100, kind: "primary" },
		],
	});

//#endregion

//#region Signals

// Warm up so the charts have history on first paint
function warmUp() {
	let seedServers = SERVER_NAMES.map((name, index) => Server.createRandom(name, index));
	const seedHistory = [];
	for (let tickNumber = 0; tickNumber < FLEET_HISTORY_LENGTH; tickNumber++) {
		seedServers = seedServers.map((server) => server.next());
		seedHistory.push(averageCpu(seedServers));
	}
	return { servers: seedServers.map((server) => server.withIncident(0)), history: seedHistory };
}

const seed = warmUp();
const servers = new Wire.State("servers", seed.servers);
const fleetHistory = new Wire.State("fleetHistory", seed.history);
const eventEntries = new Wire.State("eventEntries", []);
const tickCount = new Wire.State("tickCount", 0);
const paused = new Wire.State("paused", false);
const searchText = new Wire.State("searchText", "");
const statusFilter = new Wire.State("statusFilter", "all");
const regionFilter = new Wire.State("regionFilter", "all");
const sortKey = new Wire.State("sortKey", "status");
const selectedName = new Wire.State("selectedName", null);

// The warning must stay below the critical level, so each slider limits the other one
const cpuWarning = new Wire.State("cpuWarning", 65);
const cpuCritical = new Wire.State("cpuCritical", 85);
const latencyLimitMs = new Wire.State("latencyLimitMs", 250);
const cpuWarningMax = new Wire.Computed("cpuWarningMax", [cpuCritical], (critical) => critical - 1);
const cpuCriticalMin = new Wire.Computed("cpuCriticalMin", [cpuWarning], (warning) => warning + 1);
const thresholds = new Wire.Computed("thresholds", [cpuWarning, cpuCritical, latencyLimitMs], (cpuWarning, cpuCritical, latencyLimitMs) => ({ cpuWarning, cpuCritical, latencyLimitMs }));

const assessedServers = new Wire.Computed("assessedServers", [servers, thresholds], (servers, thresholds) => servers.map((server) => server.assess(thresholds)));

const visibleServers = new Wire.Computed(
	"visibleServers",
	[assessedServers, searchText, regionFilter, statusFilter, sortKey],
	(servers, searchText, region, status, sortKey) => {
		const query = searchText.trim().toLowerCase();
		return servers
			.filter((server) => region === "all" || server.region === region)
			.filter((server) => status === "all" || server.severity === status)
			.filter((server) => !query || server.name.includes(query) || server.region.includes(query))
			.sort(SORTERS[sortKey]);
	},
);

const selectedServer = new Wire.Computed("selectedServer", [assessedServers, selectedName], (servers, selectedName) => servers.find((server) => server.name === selectedName) ?? null);

const statusCounts = new Wire.Computed("statusCounts", [assessedServers], (servers) => ({
	all: servers.length,
	ok: countSeverity(servers, "ok"),
	warning: countSeverity(servers, "warning"),
	critical: countSeverity(servers, "critical"),
}));

const statusChips = new Wire.Computed("statusChips", [statusCounts], (counts) => STATUS_CHIPS.map((chip) => ({ ...chip, count: counts[chip.key] })));

const regionChips = new Wire.Computed("regionChips", [assessedServers], (servers) => [
	{ key: "all", label: "All regions", count: servers.length },
	...REGION_NAMES.map((region) => ({ key: region, label: region, count: servers.filter((server) => server.region === region).length })),
]);

const summaryCards = new Wire.Computed("summaryCards", [assessedServers, statusCounts, thresholds, fleetHistory], (servers, counts, thresholds, history) => {
	const cpuTrend = history.length > TREND_WINDOW_TICKS ? history.at(-1) - history.at(-1 - TREND_WINDOW_TICKS) : 0;
	const trendArrow = cpuTrend > 0.05 ? "▲" : cpuTrend < -0.05 ? "▼" : "●";
	const trendSeconds = Math.round((TREND_WINDOW_TICKS * TICK_INTERVAL_MS) / 1000);
	const averageCpuPercent = averageCpu(servers);

	const totalRequests = sumOf(servers, (server) => server.requestsPerSecond);
	const averageLatency = sumOf(servers, (server) => server.latencyMs) / servers.length;
	const slowestServer = servers.reduce((slowest, server) => (server.latencyMs > slowest.latencyMs ? server : slowest));
	const weightedErrorPercent = totalRequests ? sumOf(servers, (server) => server.errorPercent * server.requestsPerSecond) / totalRequests : 0;
	const serversOverErrorWarning = servers.filter((server) => server.errorPercent >= ERROR_THRESHOLDS.warning).length;

	return [
		{
			label: "Healthy servers",
			value: `${counts.ok} / ${counts.all}`,
			detail: `${counts.warning} degraded · ${counts.critical} critical`,
			severity: counts.critical ? "critical" : counts.warning ? "warning" : "ok",
		},
		{
			label: "Average CPU",
			value: `${averageCpuPercent.toFixed(1)}%`,
			detail: `${trendArrow} ${Math.abs(cpuTrend).toFixed(1)} pts vs ${trendSeconds}s ago`,
			severity: severityOf(averageCpuPercent, thresholds.cpuWarning, thresholds.cpuCritical),
		},
		{ label: "Throughput", value: `${formatCount(totalRequests)} req/s`, detail: `across ${counts.all} servers`, severity: "ok" },
		{
			label: "Average latency",
			value: `${Math.round(averageLatency)} ms`,
			detail: `slowest: ${slowestServer.name} (${slowestServer.latencyMs} ms)`,
			severity: severityOf(averageLatency, thresholds.latencyLimitMs, thresholds.latencyLimitMs * 2),
		},
		{
			label: "Error rate",
			value: `${weightedErrorPercent.toFixed(2)}%`,
			detail: `${serversOverErrorWarning} above ${ERROR_THRESHOLDS.warning}% errors`,
			severity: severityOf(weightedErrorPercent, 1, 3),
		},
	];
});

//#endregion

//#region Behaviour

const MAX_EVENT_ENTRIES = 30;

// severity: "info" | "ok" | "warning" | "critical"
function logEvent(severity, message) {
	const time = new Date().toLocaleTimeString([], { hour12: false });
	eventEntries.update((entries) => [{ time, severity, message }, ...entries].slice(0, MAX_EVENT_ENTRIES));
}

function updateServer(serverName, change) {
	servers.update((list) => list.map((server) => (server.name === serverName ? change(server) : server)));
}

function restart(serverName) {
	updateServer(serverName, (server) => server.restarted());
	logEvent("info", `${serverName} restarted manually`);
}

function injectIncident() {
	const calmServers = servers.get().filter((server) => server.incidentTicksLeft === 0);
	if (calmServers.length === 0) return;
	const target = calmServers[Math.floor(Math.random() * calmServers.length)];
	updateServer(target.name, (server) => server.withIncident(12));
	logEvent("warning", `Incident injected on ${target.name}`);
}

function describeCpuAgainstFleet(server) {
	const difference = server.cpuPercent - averageCpu(assessedServers.get());
	const comparison = `${Math.abs(Math.round(difference))} pts ${difference >= 0 ? "above" : "below"} the fleet average CPU`;
	return server.severity === "ok" ? `Operating normally, ${comparison}.` : `Needs attention: ${comparison}.`;
}

function tick() {
	if (paused.get()) return;
	const nextServers = servers.get().map((server) => server.next());
	tickCount.update((count) => count + 1);
	fleetHistory.update((history) => [...history, averageCpu(nextServers)].slice(-FLEET_HISTORY_LENGTH));
	servers.set(nextServers);
}

// A side effect rather than state: writes severity changes to the event log
const previousSeverity = Object.fromEntries(assessedServers.get().map((server) => [server.name, server.severity]));
assessedServers.listen((servers) => {
	for (const server of servers) {
		const before = previousSeverity[server.name];
		previousSeverity[server.name] = server.severity;
		if (before !== server.severity) {
			logEvent(server.severity, `${server.name} is now ${server.statusLabel.toLowerCase()} (CPU ${server.cpuPercent}%, ${server.latencyMs} ms)`);
		}
	}
});

logEvent("info", `Monitoring ${SERVER_NAMES.length} servers across ${REGION_NAMES.length} regions`);
setInterval(tick, TICK_INTERVAL_MS);

//#endregion
