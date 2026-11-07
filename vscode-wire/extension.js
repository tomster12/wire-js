const vscode = require("vscode");

const FILE_GLOB = "**/*.{html,htm,js,mjs}";
const FILE_EXCLUDE = "**/{node_modules,.git}/**";

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Find the token matching `regex` on the line that contains the position
function matchAtPosition(document, position, regex) {
	const line = document.lineAt(position.line).text;
	for (const m of line.matchAll(regex)) {
		const start = m.index;
		const end = start + m[0].length;
		if (position.character >= start && position.character <= end) return { match: m, start, end };
	}
	return null;
}

// Search all workspace files for `regex` (must have capture group 1 = the part to jump to)
async function findDefinitions(regex, originRange) {
	const uris = await vscode.workspace.findFiles(FILE_GLOB, FILE_EXCLUDE);
	const links = [];
	for (const uri of uris) {
		let doc;
		try {
			doc = await vscode.workspace.openTextDocument(uri);
		} catch {
			continue;
		}
		const text = doc.getText();
		regex.lastIndex = 0;
		for (const m of text.matchAll(regex)) {
			const groupOffset = m[0].indexOf(m[1]);
			const start = doc.positionAt(m.index + groupOffset);
			const end = doc.positionAt(m.index + groupOffset + m[1].length);
			const range = new vscode.Range(start, end);
			links.push({ originSelectionRange: originRange, targetUri: uri, targetRange: range, targetSelectionRange: range });
		}
	}
	return links;
}

const provider = {
	async provideDefinition(document, position) {
		// "@signalName" attribute value -> new State("signalName") / new Computed("signalName")
		const sig = matchAtPosition(document, position, /(?<=["'])@([A-Za-z_$][\w$]*)(?=["'])/g);
		if (sig) {
			const name = sig.match[1];
			const origin = new vscode.Range(position.line, sig.start, position.line, sig.end);
			const regex = new RegExp(
				`new\\s+(?:Wire\\.)?(?:State|Computed)\\s*\\(\\s*["'\`](${escapeRegExp(name)})["'\`]`,
				"g",
			);
			return findDefinitions(regex, origin);
		}

		// name="component-name" -> <component name="component-name" ...> (the template, not an instance)
		const comp = matchAtPosition(document, position, /\bname\s*=\s*(["'])([^"']+)\1/g);
		if (comp) {
			const name = comp.match[2];
			const lineText = document.lineAt(position.line).text;
			if (!/<component\b/.test(lineText.slice(0, comp.start))) return null;
			const valueStart = comp.start + comp.match[0].indexOf(name, comp.match[0].indexOf("=") + 1);
			const origin = new vscode.Range(position.line, valueStart, position.line, valueStart + name.length);
			const tagRegex = new RegExp(
				`<component\\b[^>]*?\\bname\\s*=\\s*["'](${escapeRegExp(name)})["'][^>]*>`,
				"g",
			);
			const all = await findDefinitions(tagRegex, origin);
			// Keep only template definitions (no `instance` attribute)
			const defs = [];
			for (const link of all) {
				const doc = await vscode.workspace.openTextDocument(link.targetUri);
				const tagLine = doc.lineAt(link.targetRange.start.line).text;
				const tagStart = tagLine.lastIndexOf("<component", link.targetRange.start.character);
				const tagEnd = tagLine.indexOf(">", link.targetRange.start.character);
				const tag = tagLine.slice(Math.max(tagStart, 0), tagEnd === -1 ? undefined : tagEnd);
				if (!/\binstance\b/.test(tag)) defs.push(link);
			}
			return defs;
		}

		return null;
	},
};

function activate(context) {
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider([{ language: "html" }], provider),
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
