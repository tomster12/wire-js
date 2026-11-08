// Wire Beats: a drum machine and synth with a live spectrum.
// Wire owns every pixel of the UI. This file is the audio engine plus a handful of State and Computed signals.

//#region Configuration

const STEP_COUNT = 16;
const BAR_COUNT = 32;
const SCHEDULE_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;

const TRACK_DEFINITIONS = [
	{ id: "kick", name: "Kick", color: "#ff4d6d", level: 5 },
	{ id: "snare", name: "Snare", color: "#ffa94d", level: 4 },
	{ id: "clap", name: "Clap", color: "#ffe066", level: 3 },
	{ id: "hat", name: "Hi-hat", color: "#3df5c0", level: 3 },
	{ id: "bass", name: "Bass", color: "#4da3ff", level: 4 },
	{ id: "lead", name: "Lead", color: "#b794ff", level: 3 },
];

const SCALES = {
	minor: [0, 3, 5, 7, 10],
	major: [0, 2, 4, 7, 9],
	dorian: [0, 2, 3, 5, 7, 9, 10],
	phrygian: [0, 1, 3, 5, 7, 8, 10],
};

// One string per track, x is a hit. Order matches TRACK_DEFINITIONS
const PRESETS = {
	"Four on the floor": {
		bpm: 124, swing: 8,
		patterns: ["x...x...x...x...", "....x.......x...", "....x.......x..x", "..x...x...x...x.", "x..x..x.x..x..x.", "..x.....x..x...x"],
	},
	"Hip hop": {
		bpm: 88, swing: 30,
		patterns: ["x.....x..x......", "....x.......x...", "................", "x.x.x.x.x.x.x.xx", "x.....x..x..x...", "......x.......x."],
	},
	Breakbeat: {
		bpm: 136, swing: 12,
		patterns: ["x.....x...x..x..", "....x..x.x..x...", "....x.......x...", "x.x.x.x.x.x.x.x.", "x.....x...x.....", "x..x..x...x..x.."],
	},
	Techno: {
		bpm: 140, swing: 0,
		patterns: ["x...x...x...x...", "................", "....x.......x...", ".x.x.x.x.x.x.x.x", ".x.x.x.x.x.x.x.x", "x.x...x.x..xx..."],
	},
};

const MUSIC_START = { root: 36, scale: "minor" };

//#endregion

//#region Utilities

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const midiToHz = (note) => 440 * Math.pow(2, (note - 69) / 12);
const stepsFromPattern = (pattern) => [...pattern].map((character) => character === "x");

//#endregion

//#region Share code, the whole beat as a short string stored in the URL hash

const stepsToHex = (steps) => steps.reduce((bits, on, index) => bits | (on ? 1 << index : 0), 0).toString(16).padStart(4, "0");
const hexToSteps = (hex) => Array.from({ length: STEP_COUNT }, (_, index) => Boolean(parseInt(hex, 16) & (1 << index)));

function parseShareCode(code) {
	try {
		const [bpm, swing, root, scale, patterns] = code.replace(/^#/, "").split("_");
		const parsed = { bpm: Number(bpm), swing: Number(swing), root: Number(root), scale, steps: patterns.split("-").map(hexToSteps) };
		const isValid = parsed.bpm >= 70 && parsed.bpm <= 180 && parsed.swing >= 0 && parsed.swing <= 60 && parsed.root >= 24 && parsed.root <= 60 && parsed.scale in SCALES && parsed.steps.length === TRACK_DEFINITIONS.length;
		return isValid ? parsed : null;
	} catch {
		return null;
	}
}

//#endregion

//#region State

const fromUrl = parseShareCode(location.hash);
const startPreset = PRESETS["Four on the floor"];

const tracks = new Wire.State(
	"tracks",
	TRACK_DEFINITIONS.map((definition, index) => ({
		...definition,
		steps: fromUrl ? fromUrl.steps[index] : stepsFromPattern(startPreset.patterns[index]),
		muted: false,
		solo: false,
	})),
);
const bpm = new Wire.State("bpm", fromUrl?.bpm ?? startPreset.bpm);
const swing = new Wire.State("swing", fromUrl?.swing ?? startPreset.swing);
const masterVolume = new Wire.State("masterVolume", 80);
const root = new Wire.State("root", fromUrl?.root ?? MUSIC_START.root);
const scale = new Wire.State("scale", fromUrl?.scale ?? MUSIC_START.scale);
const playing = new Wire.State("playing", false);
const currentStep = new Wire.State("currentStep", -1);
const levels = new Wire.State("levels", new Array(BAR_COUNT).fill(0));
const copyLabel = new Wire.State("copyLabel", "Copy link");
const stepNumbers = new Wire.State("stepNumbers", Array.from({ length: STEP_COUNT }, (_, index) => index));
const presetNames = new Wire.State("presetNames", Object.keys(PRESETS));

//#endregion

//#region Derived values

// Solo wins over mute, and a track is only audible if nothing else is soloed
const rows = new Wire.Computed("rows", [tracks], (tracks) => {
	const anySolo = tracks.some((track) => track.solo);
	return tracks.map((track) => ({
		...track,
		audible: !track.muted && (!anySolo || track.solo),
		cells: track.steps.map((on, index) => ({ index, on, group: Math.floor(index / 4) % 2 })),
	}));
});

const audibleTracks = new Wire.Computed("audibleTracks", [rows], (rows) => rows.filter((row) => row.audible));

const statChips = new Wire.Computed("statChips", [rows, bpm], (rows, bpm) => {
	const hits = rows.reduce((total, row) => total + row.steps.filter(Boolean).length, 0);
	const density = Math.round((hits / (rows.length * STEP_COUNT)) * 100);
	const secondsPerBar = (60 / bpm) * 4;
	return [
		{ value: hits, label: "hits per bar" },
		{ value: `${density}%`, label: "dense" },
		{ value: rows.filter((row) => row.audible).length, label: "voices" },
		{ value: `${secondsPerBar.toFixed(2)}s`, label: "per bar" },
	];
});

const shareCode = new Wire.Computed("shareCode", [bpm, swing, root, scale, tracks], (bpm, swing, root, scale, tracks) => `${bpm}_${swing}_${root}_${scale}_${tracks.map((track) => stepsToHex(track.steps)).join("-")}`);

// Mean level, drives the glow behind the page
const energy = new Wire.Computed("energy", [levels], (levels) => Math.round((levels.reduce((total, level) => total + level, 0) / levels.length) * 100) / 100);

//#endregion

//#region Rendering helpers, strings that the templates insert with {{{ }}}

function liveCss(step, energy) {
	let rules = `:root{--energy:${energy}}`;
	if (step >= 0) {
		rules += `.cell[data-step="${step}"]{transform:translateY(-3px) scale(1.07);filter:brightness(1.5)}`;
		rules += `.cell.on[data-step="${step}"]{box-shadow:0 0 26px var(--c),0 0 6px #fff}`;
		rules += `.step-num[data-step="${step}"]{color:#fff;background:rgba(255,255,255,.2)}`;
	}
	return `<style>${rules}</style>`;
}

function spectrumSvg(values) {
	const width = 640;
	const height = 120;
	const slot = width / values.length;
	let bars = "";
	values.forEach((value, index) => {
		const barHeight = Math.max(3, value * height * 0.95);
		const x = (index * slot + slot * 0.16).toFixed(1);
		bars += `<rect x="${x}" y="${((height - barHeight) / 2).toFixed(1)}" width="${(slot * 0.68).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="${(slot * 0.34).toFixed(1)}" fill="url(#bar-gradient)"/>`;
	});
	return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="spectrum"><defs><linearGradient id="bar-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4d9d"/><stop offset="0.5" stop-color="#8f6bff"/><stop offset="1" stop-color="#3df5c0"/></linearGradient></defs>${bars}</svg>`;
}

//#endregion

//#region Pattern editing

let paintValue = null;

function updateTrack(trackId, change) {
	tracks.update((list) => list.map((track) => (track.id === trackId ? { ...track, ...change(track) } : track)));
}

function setStep(trackId, index, isOn) {
	const track = tracks.get().find((candidate) => candidate.id === trackId);
	if (track.steps[index] === isOn) return;
	updateTrack(trackId, (track) => ({ steps: track.steps.map((on, stepIndex) => (stepIndex === index ? isOn : on)) }));
}

// Press decides whether the drag paints or erases, entering other cells with the button held applies the same value
function paintStart(trackId, index) {
	const track = tracks.get().find((candidate) => candidate.id === trackId);
	paintValue = !track.steps[index];
	setStep(trackId, index, paintValue);
	if (paintValue) audition(trackId, index);
}

function paintOver(trackId, index, event) {
	if (event.buttons !== 1 || paintValue === null) return;
	setStep(trackId, index, paintValue);
}

window.addEventListener("mouseup", () => {
	paintValue = null;
});

function toggleTrackFlag(trackId, flag) {
	updateTrack(trackId, (track) => ({ [flag]: !track[flag] }));
}

function setLevel(trackId, level) {
	updateTrack(trackId, () => ({ level }));
	audition(trackId, 0);
}

function applyPreset(name) {
	const preset = PRESETS[name];
	tracks.update((list) => list.map((track, index) => ({ ...track, steps: stepsFromPattern(preset.patterns[index]) })));
	bpm.set(preset.bpm);
	swing.set(preset.swing);
}

function randomize() {
	const densities = [0.25, 0.14, 0.1, 0.5, 0.3, 0.25];
	tracks.update((list) =>
		list.map((track, index) => ({
			...track,
			steps: track.steps.map((_, step) => (index === 0 && step % 4 === 0 && Math.random() < 0.8) || Math.random() < densities[index]),
		})),
	);
}

function clearPattern() {
	tracks.update((list) => list.map((track) => ({ ...track, steps: new Array(STEP_COUNT).fill(false) })));
}

async function copyLink() {
	try {
		await navigator.clipboard.writeText(location.href);
		copyLabel.set("Copied ✔");
	} catch {
		copyLabel.set("Copy failed");
	}
	setTimeout(() => copyLabel.set("Copy link"), 1500);
}

//#endregion

//#region Audio engine

let audio = null;

function ensureAudio() {
	if (audio) return audio;

	const context = new (window.AudioContext || window.webkitAudioContext)();
	const master = context.createGain();
	const compressor = context.createDynamicsCompressor();
	const analyser = context.createAnalyser();
	analyser.fftSize = 128;
	analyser.smoothingTimeConstant = 0.78;
	master.connect(compressor);
	compressor.connect(analyser);
	analyser.connect(context.destination);

	const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
	const noiseData = noise.getChannelData(0);
	for (let index = 0; index < noiseData.length; index++) noiseData[index] = Math.random() * 2 - 1;

	audio = { context, master, analyser, noise, bins: new Uint8Array(analyser.frequencyBinCount) };
	return audio;
}

function envelope(peak, time, decay, destination) {
	const gain = audio.context.createGain();
	gain.gain.setValueAtTime(peak, time);
	gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
	gain.connect(destination);
	return gain;
}

function tone(type, frequency, time, duration, destination, endFrequency) {
	const oscillator = audio.context.createOscillator();
	oscillator.type = type;
	oscillator.frequency.setValueAtTime(frequency, time);
	if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + duration * 0.4);
	oscillator.connect(destination);
	oscillator.start(time);
	oscillator.stop(time + duration + 0.05);
}

function noiseBurst(time, duration, filterType, frequency, destination, q = 1) {
	const source = audio.context.createBufferSource();
	source.buffer = audio.noise;
	const filter = audio.context.createBiquadFilter();
	filter.type = filterType;
	filter.frequency.value = frequency;
	filter.Q.value = q;
	source.connect(filter);
	filter.connect(destination);
	source.start(time, Math.random() * 0.5, duration + 0.05);
}

const VOICES = {
	kick(time, out) {
		tone("sine", 165, time, 0.45, envelope(1, time, 0.45, out), 42);
	},
	snare(time, out) {
		noiseBurst(time, 0.2, "highpass", 1400, envelope(0.55, time, 0.18, out));
		tone("triangle", 200, time, 0.12, envelope(0.45, time, 0.1, out), 120);
	},
	clap(time, out) {
		[0, 0.013, 0.027].forEach((offset, index) => noiseBurst(time + offset, 0.16, "bandpass", 1500, envelope(0.5, time + offset, index === 2 ? 0.2 : 0.03, out), 0.8));
	},
	hat(time, out) {
		noiseBurst(time, 0.06, "highpass", 8000, envelope(0.28, time, 0.05, out));
	},
	bass(time, out, step) {
		const filter = audio.context.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.setValueAtTime(900, time);
		filter.frequency.exponentialRampToValueAtTime(140, time + 0.25);
		filter.connect(envelope(0.6, time, 0.32, out));
		tone("sawtooth", midiToHz(root.get()), time, 0.32, filter);
	},
	lead(time, out, step) {
		const notes = SCALES[scale.get()];
		const note = root.get() + 24 + notes[(step * 3 + Math.floor(step / 8)) % notes.length];
		const filter = audio.context.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.value = 2600;
		filter.connect(envelope(0.16, time, 0.24, out));
		tone("square", midiToHz(note), time, 0.24, filter);
	},
};

function playVoice(track, step, time) {
	const output = audio.context.createGain();
	output.gain.value = (track.level / 5) ** 1.5;
	output.connect(audio.master);
	VOICES[track.id](time, output, step);
}

// Plays a sound immediately when you paint a step or change a level
function audition(trackId, step) {
	ensureAudio();
	audio.context.resume();
	audio.master.gain.value = masterVolume.get() / 100;
	const track = rows.get().find((row) => row.id === trackId);
	playVoice(track, step, audio.context.currentTime + 0.01);
}

//#endregion

//#region Sequencer

let schedulerTimer = null;
let nextStepTime = 0;
let scheduledStep = 0;

function playStep(step, time) {
	audio.master.gain.value = masterVolume.get() / 100;
	for (const track of audibleTracks.get()) {
		if (track.steps[step]) playVoice(track, step, time);
	}
}

// Looks a little ahead of the audio clock so timing stays tight even when the page is busy
function scheduleAhead() {
	const { context } = audio;
	while (nextStepTime < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
		const step = scheduledStep;
		playStep(step, nextStepTime);
		setTimeout(() => {
			if (playing.get()) currentStep.set(step);
		}, Math.max(0, (nextStepTime - context.currentTime) * 1000));

		// Swing makes the even steps longer and the odd steps shorter, the pair still adds up to two steps
		const stepSeconds = 60 / bpm.get() / 4;
		const swingAmount = (swing.get() / 100) * 0.5;
		nextStepTime += stepSeconds * (step % 2 === 0 ? 1 + swingAmount : 1 - swingAmount);
		scheduledStep = (scheduledStep + 1) % STEP_COUNT;
	}
}

function togglePlayback() {
	if (playing.get()) {
		clearInterval(schedulerTimer);
		playing.set(false);
		currentStep.set(-1);
		return;
	}

	ensureAudio();
	audio.context.resume();
	scheduledStep = 0;
	nextStepTime = audio.context.currentTime + 0.06;
	schedulerTimer = setInterval(scheduleAhead, SCHEDULER_INTERVAL_MS);
	playing.set(true);
}

window.addEventListener("keydown", (event) => {
	if (event.code !== "Space" || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
	event.preventDefault();
	togglePlayback();
});

//#endregion

//#region Spectrum

let frameNumber = 0;

// Real analyser data while playing, a slow idle wave otherwise, written into one signal
function animateSpectrum(timestamp) {
	requestAnimationFrame(animateSpectrum);
	if (++frameNumber % 2 !== 0) return;

	let nextLevels;
	if (audio && playing.get()) {
		audio.analyser.getByteFrequencyData(audio.bins);
		nextLevels = Array.from({ length: BAR_COUNT }, (_, index) => {
			const from = Math.floor(Math.pow(index / BAR_COUNT, 1.7) * audio.bins.length * 0.85);
			const to = Math.max(from + 1, Math.floor(Math.pow((index + 1) / BAR_COUNT, 1.7) * audio.bins.length * 0.85));
			let peak = 0;
			for (let bin = from; bin < to; bin++) peak = Math.max(peak, audio.bins[bin]);
			return Math.round(clamp((peak / 255) * 1.15, 0, 1) * 100) / 100;
		});
	} else {
		const time = timestamp / 900;
		nextLevels = Array.from({ length: BAR_COUNT }, (_, index) => Math.round((0.07 + 0.05 * Math.sin(time + index * 0.45)) * 100) / 100);
	}
	levels.set(nextLevels);
}

requestAnimationFrame(animateSpectrum);

//#endregion

//#region Side effects

// The beat is mirrored into the URL, so any page address is a shareable song
shareCode.listen((code) => {
	try {
		history.replaceState(null, "", `#${code}`);
	} catch {
		// opened from a place that does not allow it, sharing just stays off
	}
});

//#endregion
