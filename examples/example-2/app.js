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

const DEFAULT_THRESHOLDS = { cpuWarning: 65, cpuCritical: 85, latencyLimitMs: 250 };
const MEMORY_THRESHOLDS = { warning: 75, critical: 90 };
const ERROR_THRESHOLDS = { warning: 2, critical: 5 };

const SEVERITY_RANK = { ok: 0, warning: 1, critical: 2 };
const SEVERITY_LABEL = { ok: "Healthy", warning: "Degraded", critical: "Critical" };

//#endregion

//#region Utilities

const randomBetween = (min, max) => min + Math.random() * (max - min);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const roundToTenth = (value) => Math.round(value * 10) / 10;

const sumOf = (items, getValue) => items.reduce((total, item) => total + getValue(item), 0);

const formatCount = (value) => Math.round(value).toLocaleString("en-US");

function severityOf(value, warningAt, criticalAt) {
	if (value >= criticalAt) return "critical";
	if (value >= warningAt) return "warning";
	return "ok";
}

function createReferenceStabiliser() {
	// Wire signals only notify when the value's reference changes, so returning the previous array
	// while the content is identical stops buttons being rebuilt (and clicks lost) on every tick.
	let lastJson = null;
	let lastValue = null;
	return (nextValue) => {
		const json = JSON.stringify(nextValue);
		if (json === lastJson) return lastValue;
		lastJson = json;
		lastValue = nextValue;
		return nextValue;
	};
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

	copyWith(changes) {
		// Servers are immutable: every change makes a new instance so Wire sees a new reference
		return Object.assign(new Server(), this, changes);
	}

	get statusLabel() {
		return SEVERITY_LABEL[this.severity];
	}

	next() {
		// Advance the simulation by one tick (stands in for a real websocket / polling feed)
		let incidentTicksLeft = this.incidentTicksLeft;
		if (incidentTicksLeft === 0 && Math.random() < 0.012) incidentTicksLeft = Math.floor(randomBetween(8, 16));
		const underIncident = incidentTicksLeft > 0;
		const { baseline } = this;

		const cpuTarget = underIncident ? 95 : baseline.cpuPercent;
		const cpuPercent = clamp(this.cpuPercent + (cpuTarget - this.cpuPercent) * (underIncident ? 0.35 : 0.12) + randomBetween(-4, 4), 2, 99);
		const memoryDrift = underIncident ? 0.8 : (baseline.memoryPercent - this.memoryPercent) * 0.1;
		const memoryPercent = clamp(this.memoryPercent + memoryDrift + randomBetween(-0.6, 0.6), 10, 98);
		const incidentLatency = underIncident ? randomBetween(80, 200) : 0;
		const latencyMs = clamp(baseline.latencyMs * (1 + cpuPercent / 80) + incidentLatency + randomBetween(-6, 6), 8, 900);
		const errorPercent = clamp(underIncident ? this.errorPercent + randomBetween(0.2, 1.1) : this.errorPercent * 0.7 + randomBetween(0, 0.15), 0, 20);
		const trafficNoise = baseline.requestsPerSecond * 0.04;
		const trafficLoss = underIncident ? baseline.requestsPerSecond * 0.03 : 0;
		const requestsPerSecond = Math.max(0, this.requestsPerSecond + (baseline.requestsPerSecond - this.requestsPerSecond) * 0.2 + randomBetween(-trafficNoise, trafficNoise) - trafficLoss);

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

	assess(thresholds) {
		// Rate each metric against the thresholds; overall severity is the worst of them
		const cpuSeverity = severityOf(this.cpuPercent, thresholds.cpuWarning, thresholds.cpuCritical);
		const memorySeverity = severityOf(this.memoryPercent, MEMORY_THRESHOLDS.warning, MEMORY_THRESHOLDS.critical);
		const latencySeverity = severityOf(this.latencyMs, thresholds.latencyLimitMs, thresholds.latencyLimitMs * 2);
		const errorSeverity = severityOf(this.errorPercent, ERROR_THRESHOLDS.warning, ERROR_THRESHOLDS.critical);
		const severity = [cpuSeverity, memorySeverity, latencySeverity, errorSeverity].reduce((worst, current) =>
			SEVERITY_RANK[current] > SEVERITY_RANK[worst] ? current : worst,
		);
		return this.copyWith({ cpuSeverity, memorySeverity, latencySeverity, errorSeverity, severity });
	}
}

//#endregion

//#region EventLog

class EventLog {
	constructor(maxEntries = 30) {
		this.maxEntries = maxEntries;
		this.entries = new Wire.State("eventEntries", []);
	}

	record(severity, message) {
		// severity: "info" | "ok" | "warning" | "critical"
		const time = new Date().toLocaleTimeString([], { hour12: false });
		this.entries.set([{ time, severity, message }, ...this.entries.get()].slice(0, this.maxEntries));
	}
}

//#endregion

//#region Charts

const GRID_GUIDES = [25, 50, 75].map((value) => ({ value, max: 100, kind: "grid" }));

function buildChartShapes({ width, height, pointCount, series, guides = [] }) {
	// Draws the guide lines, then each series as a line (optionally filled).
	// Series are right-aligned so new points scroll in from the right.
	const xAt = (index) => ((index / (pointCount - 1)) * width).toFixed(1);
	const yAt = (value, max) => (height - clamp(value / max, 0, 1) * height).toFixed(1);
	let shapes = "";

	for (const guide of guides) {
		const y = yAt(guide.value, guide.max);
		shapes += `<line class="guide ${guide.kind}" x1="0" x2="${width}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`;
	}

	for (const line of series) {
		const offset = pointCount - line.data.length;
		const points = line.data.map((value, i) => `${xAt(i + offset)},${yAt(value, line.max)}`).join(" ");
		if (line.filled) shapes += `<polygon class="area ${line.kind}" points="${xAt(offset)},${height} ${points} ${width},${height}"/>`;
		shapes += `<polyline class="line ${line.kind}" points="${points}" vector-effect="non-scaling-stroke"/>`;
	}

	return shapes;
}

function wrapInSvg(shapes, width, height, extraClass = "") {
	return `<svg class="chart ${extraClass}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${shapes}</svg>`;
}

function sparklineShapes(cpuHistory) {
	// Only the shapes: the server row template supplies the surrounding <svg>
	return buildChartShapes({ width: 100, height: 28, pointCount: SERVER_HISTORY_LENGTH, series: [{ data: cpuHistory, max: 100, kind: "primary" }] });
}

//#endregion

//#region ServerFarm

class ServerFarm {
	constructor() {
		this.eventLog = new EventLog();
		this.#createState();
		this.#createDerivedState();
		this.#logStatusChanges();
		this.eventLog.record("info", `Monitoring ${SERVER_NAMES.length} servers across ${REGION_NAMES.length} regions`);
	}

	#createState() {
		// Warm up so the charts have history on first paint
		let seedServers = SERVER_NAMES.map((name, index) => Server.createRandom(name, index));
		const seedFleetHistory = [];
		for (let i = 0; i < FLEET_HISTORY_LENGTH; i++) {
			seedServers = seedServers.map((server) => server.next());
			seedFleetHistory.push(this.#averageCpu(seedServers));
		}
		seedServers = seedServers.map((server) => server.withIncident(0));

		// Every public signal is registered with Wire under the same name as its property,
		// so templates can refer to them as @name or through the global `farm`
		this.servers = new Wire.State("servers", seedServers);
		
		this.fleetHistory = new Wire.State("fleetHistory", seedFleetHistory);

		// The sliders in index.html must start at these values
		this.thresholds = new Wire.State("thresholds", DEFAULT_THRESHOLDS);

		this.tickCount = new Wire.State("tickCount", 0);
		
		this.paused = new Wire.State("paused", false);

		this.searchText = new Wire.State("searchText", "");
		
		this.statusFilter = new Wire.State("statusFilter", "all");
		
		this.regionFilter = new Wire.State("regionFilter", "all");
		
		this.sortKey = new Wire.State("sortKey", "status");

		this.selectedName = new Wire.State("selectedName", null);
	}

	#createDerivedState() {
		this.assessedServers = new Wire.Computed("assessedServers", [this.servers, this.thresholds], (servers, thresholds) =>
			servers.map((server) => server.assess(thresholds)),
		);

		this.visibleServers = new Wire.Computed(
			"visibleServers",
			[this.assessedServers, this.searchText, this.regionFilter, this.statusFilter, this.sortKey],
			(servers, searchText, region, status, sortKey) => {
				const query = searchText.trim().toLowerCase();
				return servers
					.filter((server) => region === "all" || server.region === region)
					.filter((server) => status === "all" || server.severity === status)
					.filter((server) => !query || server.name.includes(query) || server.region.includes(query))
					.sort(ServerFarm.SORTERS[sortKey]);
			},
		);

		// Adds the selection highlight so the list re-renders when the selection changes
		this.serverRows = new Wire.Computed("serverRows", [this.visibleServers, this.selectedName], (servers, selectedName) =>
			servers.map((server) => server.copyWith({ isSelected: server.name === selectedName })),
		);

		this.selectedServer = new Wire.Computed("selectedServer", [this.assessedServers, this.selectedName], (servers, selectedName) =>
			servers.find((server) => server.name === selectedName) ?? null,
		);

		// A list of zero or one servers, so the detail panel can use <wire for each="server">
		// to bind the selected server as a variable (and render nothing when there is none)
		this.selectedServerAsList = new Wire.Computed("selectedServerAsList", [this.selectedServer], (server) => (server ? [server] : []));

		this.statusCounts = new Wire.Computed("statusCounts", [this.assessedServers], (servers) => ({
			all: servers.length,
			ok: servers.filter((server) => server.severity === "ok").length,
			warning: servers.filter((server) => server.severity === "warning").length,
			critical: servers.filter((server) => server.severity === "critical").length,
		}));

		const stabiliseStatusChips = createReferenceStabiliser();
		this.statusChips = new Wire.Computed("statusChips", [this.statusCounts, this.statusFilter], (counts, activeStatus) =>
			stabiliseStatusChips(
				[
					{ key: "all", label: "All" },
					{ key: "ok", label: SEVERITY_LABEL.ok },
					{ key: "warning", label: SEVERITY_LABEL.warning },
					{ key: "critical", label: SEVERITY_LABEL.critical },
				].map((chip) => ({ ...chip, count: counts[chip.key], isActive: chip.key === activeStatus })),
			),
		);

		const stabiliseRegionChips = createReferenceStabiliser();
		this.regionChips = new Wire.Computed("regionChips", [this.assessedServers, this.regionFilter], (servers, activeRegion) =>
			stabiliseRegionChips(
				[{ key: "all", label: "All regions", count: servers.length }, ...REGION_NAMES.map((region) => ({ key: region, label: region, count: servers.filter((server) => server.region === region).length }))].map(
					(chip) => ({ ...chip, isActive: chip.key === activeRegion }),
				),
			),
		);

		this.summaryCards = new Wire.Computed("summaryCards", [this.assessedServers], (servers) => this.#buildSummaryCards(servers));

		this.fleetCpuChartSvg = new Wire.Computed("fleetCpuChartSvg", [this.fleetHistory, this.thresholds], (history, thresholds) =>
			wrapInSvg(
				buildChartShapes({
					width: 600,
					height: 160,
					pointCount: FLEET_HISTORY_LENGTH,
					guides: [...GRID_GUIDES, { value: thresholds.cpuWarning, max: 100, kind: "warning" }, { value: thresholds.cpuCritical, max: 100, kind: "critical" }],
					series: [{ data: history, max: 100, kind: "primary", filled: true }],
				}),
				600,
				160,
				"tall",
			),
		);

		this.selectedServerChartSvg = new Wire.Computed("selectedServerChartSvg", [this.selectedServer, this.thresholds], (server, thresholds) =>
			server
				? wrapInSvg(
					buildChartShapes({
						width: 300,
						height: 110,
						pointCount: SERVER_HISTORY_LENGTH,
						guides: [...GRID_GUIDES, { value: thresholds.cpuWarning, max: 100, kind: "warning" }],
						series: [
							{ data: server.latencyHistory, max: thresholds.latencyLimitMs * 3, kind: "secondary" },
							{ data: server.cpuHistory, max: 100, kind: "primary" },
						],
					}),
					300,
					110,
				)
				: "",
		);
	}

	#buildSummaryCards(servers) {
		const thresholds = this.thresholds.get();
		const history = this.fleetHistory.get();
		const serverCount = servers.length;

		const healthyCount = servers.filter((server) => server.severity === "ok").length;
		const degradedCount = servers.filter((server) => server.severity === "warning").length;
		const criticalCount = servers.filter((server) => server.severity === "critical").length;

		const averageCpu = this.#averageCpu(servers);
		const cpuTrend = history.length > TREND_WINDOW_TICKS ? history[history.length - 1] - history[history.length - 1 - TREND_WINDOW_TICKS] : 0;
		const trendArrow = cpuTrend > 0.05 ? "▲" : cpuTrend < -0.05 ? "▼" : "●";
		const trendSeconds = Math.round((TREND_WINDOW_TICKS * TICK_INTERVAL_MS) / 1000);

		const totalRequests = sumOf(servers, (server) => server.requestsPerSecond);
		const averageLatency = sumOf(servers, (server) => server.latencyMs) / serverCount;
		const slowestServer = servers.reduce((slowest, server) => (server.latencyMs > slowest.latencyMs ? server : slowest));
		const requestWeightedErrorPercent = totalRequests ? sumOf(servers, (server) => server.errorPercent * server.requestsPerSecond) / totalRequests : 0;
		const serversOverErrorWarning = servers.filter((server) => server.errorPercent >= ERROR_THRESHOLDS.warning).length;

		return [
			{
				label: "Healthy servers",
				value: `${healthyCount} / ${serverCount}`,
				detail: `${degradedCount} degraded · ${criticalCount} critical`,
				severity: criticalCount ? "critical" : degradedCount ? "warning" : "ok",
			},
			{
				label: "Average CPU",
				value: `${averageCpu.toFixed(1)}%`,
				detail: `${trendArrow} ${Math.abs(cpuTrend).toFixed(1)} pts vs ${trendSeconds}s ago`,
				severity: severityOf(averageCpu, thresholds.cpuWarning, thresholds.cpuCritical),
			},
			{
				label: "Throughput",
				value: `${formatCount(totalRequests)} req/s`,
				detail: `across ${serverCount} servers`,
				severity: "ok",
			},
			{
				label: "Average latency",
				value: `${Math.round(averageLatency)} ms`,
				detail: `slowest: ${slowestServer.name} (${slowestServer.latencyMs} ms)`,
				severity: severityOf(averageLatency, thresholds.latencyLimitMs, thresholds.latencyLimitMs * 2),
			},
			{
				label: "Error rate",
				value: `${requestWeightedErrorPercent.toFixed(2)}%`,
				detail: `${serversOverErrorWarning} above ${ERROR_THRESHOLDS.warning}% errors`,
				severity: severityOf(requestWeightedErrorPercent, 1, 3),
			},
		];
	}

	#averageCpu(servers) {
		return roundToTenth(sumOf(servers, (server) => server.cpuPercent) / servers.length);
	}

	#logStatusChanges() {
		// A side effect rather than state: watches severity transitions and writes them to the event log
		const previousSeverity = {};
		this.assessedServers.get().forEach((server) => (previousSeverity[server.name] = server.severity));

		this.assessedServers.listen((servers) => {
			for (const server of servers) {
				const before = previousSeverity[server.name];
				previousSeverity[server.name] = server.severity;
				if (before && before !== server.severity) {
					this.eventLog.record(server.severity, `${server.name} is now ${server.statusLabel.toLowerCase()} (CPU ${server.cpuPercent}%, ${server.latencyMs} ms)`);
				}
			}
		});
	}

	tick() {
		if (this.paused.get()) return;
		const nextServers = this.servers.get().map((server) => server.next());
		this.tickCount.set(this.tickCount.get() + 1);
		this.fleetHistory.set([...this.fleetHistory.get(), this.#averageCpu(nextServers)].slice(-FLEET_HISTORY_LENGTH));
		// Last on purpose: summaryCards reads fleetHistory, so it must already hold this tick's point
		this.servers.set(nextServers);
	}

	startTicking() {
		setInterval(() => this.tick(), TICK_INTERVAL_MS);
	}

	togglePause() {
		this.paused.set(!this.paused.get());
	}

	select(serverName) {
		this.selectedName.set(this.selectedName.get() === serverName ? null : serverName);
	}

	restart(serverName) {
		this.servers.set(this.servers.get().map((server) => (server.name === serverName ? server.restarted() : server)));
		this.eventLog.record("info", `${serverName} restarted manually`);
	}

	injectIncident() {
		const calmServers = this.servers.get().filter((server) => server.incidentTicksLeft === 0);
		if (calmServers.length === 0) return;
		const target = calmServers[Math.floor(Math.random() * calmServers.length)];
		this.servers.set(this.servers.get().map((server) => (server.name === target.name ? server.withIncident(12) : server)));
		this.eventLog.record("warning", `Incident injected on ${target.name}`);
	}

	setCpuWarning(value) {
		// The threshold setters return the value actually applied so a slider can snap back
		const applied = Math.min(value, this.thresholds.get().cpuCritical - 1);
		this.thresholds.set({ ...this.thresholds.get(), cpuWarning: applied });
		return applied;
	}

	setCpuCritical(value) {
		const applied = Math.max(value, this.thresholds.get().cpuWarning + 1);
		this.thresholds.set({ ...this.thresholds.get(), cpuCritical: applied });
		return applied;
	}

	setLatencyLimit(value) {
		this.thresholds.set({ ...this.thresholds.get(), latencyLimitMs: value });
		return value;
	}

	setSearchText(text) {
		this.searchText.set(text);
	}

	setStatusFilter(status) {
		this.statusFilter.set(status);
	}

	setRegionFilter(region) {
		this.regionFilter.set(region);
	}

	setSortKey(key) {
		this.sortKey.set(key);
	}

	describeCpuAgainstFleet(server) {
		const difference = server.cpuPercent - this.#averageCpu(this.assessedServers.get());
		const comparison = `${Math.abs(Math.round(difference))} pts ${difference >= 0 ? "above" : "below"} the fleet average CPU`;
		return server.severity === "ok" ? `Operating normally, ${comparison}.` : `Needs attention: ${comparison}.`;
	}

	static SORTERS = {
		name: (a, b) => a.name.localeCompare(b.name),
		status: (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.cpuPercent - a.cpuPercent,
		cpu: (a, b) => b.cpuPercent - a.cpuPercent,
		latency: (a, b) => b.latencyMs - a.latencyMs,
		errors: (a, b) => b.errorPercent - a.errorPercent,
	};
}

//#endregion

const farm = new ServerFarm();
farm.startTicking();
