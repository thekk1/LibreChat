"use strict";
/** BOS-Patch: Subagenten rufen die MCP-Server auf und halten den Kontext des Hauptagenten klein.
 *  Listen aus Werkzeugergebnissen landen deshalb nie im Modell des Hauptagenten: Sie liegen je Nutzer
 *  und Chat in MongoDB, der Hauptagent sieht nur eine Zeile [DATA ...] und setzt die Daten mit
 *  {{data:ID}} in Auftraege und Antworten ein. Das Modul kennt keine Werkzeuge und keine Feldnamen. */
const crypto = require("crypto");

const MIN_ROWS = 20;
const TTL_DAYS = 30;
const MAX_COLUMNS = 30;
const MAX_CELL = 2000;
const MAX_HANDLES = 10;
const MAX_STORED_BYTES = 12 * 1024 * 1024;
const TYPED_SHARE = .9;
const COLLECTION = "bostooldata";
const REF_PATTERN = /\{\{data:(D-[0-9a-f]{6})(?::([^{}\n]*))?\}\}/g;
const TOTAL_FIELDS = ["total", "total_count", "totalCount", "total_found", "total_available"];
const MORE_FIELDS = ["more", "has_more", "hasMore", "truncated"];

let indexReady;
function collection() {
	const { connection } = require("mongoose");
	if (connection.readyState !== 1) throw new Error("MongoDB is not connected");
	const col = connection.collection(COLLECTION);
	indexReady ??= Promise.all([
		col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
		col.createIndex({ id: 1, user: 1, conversationId: 1 }, { unique: true })
	]);
	return col;
}
function messageText(message) {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
}
function parseJson(text) {
	const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
	if (starts.length === 0) return void 0;
	const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
	if (end <= Math.min(...starts)) return void 0;
	try {
		return JSON.parse(text.slice(Math.min(...starts), end + 1));
	} catch {
		return void 0;
	}
}
const isScalar = (value) => value === null || typeof value !== "object";
function cell(value) {
	if (value === null || value === void 0) return "";
	if (Array.isArray(value) && value.every(isScalar)) return value.join(", ");
	const text = typeof value === "object" ? JSON.stringify(value) : String(value);
	return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}...` : text;
}
function flattenRow(item) {
	if (isScalar(item)) return { value: cell(item) };
	if (Array.isArray(item)) return { value: cell(item) };
	const row = {};
	for (const [name, value] of Object.entries(item)) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const [inner, innerValue] of Object.entries(value)) row[`${name}.${inner}`] = cell(innerValue);
		else row[name] = cell(value);
	}
	return row;
}
function columnsOf(rows) {
	const columns = [];
	for (const row of rows.slice(0, 50)) for (const name of Object.keys(row)) if (!columns.includes(name) && rows.some((other) => other[name] !== "" && other[name] !== void 0)) columns.push(name);
	return columns.slice(0, MAX_COLUMNS);
}
/** Findet ohne Feldnamen: Listen, Zuordnungen Schluessel -> Objekt, Listen in verschachtelten Objekten. */
function jsonLists(value, path, depth, found) {
	if (depth > 4 || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		if (value.length >= MIN_ROWS) found.push({ field: path || "list", rows: value.map(flattenRow) });
		return;
	}
	const entries = Object.entries(value);
	if (entries.length >= MIN_ROWS && entries.every(([, entry]) => entry !== null && typeof entry === "object")) {
		found.push({
			field: path || "map",
			rows: entries.map(([key, entry]) => ({ key, ...flattenRow(entry) }))
		});
		return;
	}
	for (const [name, entry] of entries) jsonLists(entry, path ? `${path}.${name}` : name, depth + 1, found);
}
function lineSignature(line) {
	const prefix = line.match(/^\s*([-*•]|\d+[.)]|\|)\s/);
	if (prefix) return prefix[1].replace(/\d+/, "9");
	if (line.length > 120) return null;
	return line.trim().replace(/[\p{L}]+/gu, "a").replace(/\d+/g, "9").replace(/\s+/g, " ");
}
/** Textergebnisse: Folgen gleich aufgebauter Zeilen, etwa "- #123: ..." von Trac. */
function textLists(text) {
	const found = [];
	let run = [];
	let signature = null;
	const flush = () => {
		if (run.length >= MIN_ROWS) found.push({
			field: "lines",
			rows: run.map((line) => {
				const body = line.replace(/^\s*([-*•]|\d+[.)]|\|)\s+/, "").trim();
				return { id: body.split(/\s+/)[0].replace(/^[#"'`]+|[:,;"'`]+$/g, ""), line: body };
			})
		});
		run = [];
	};
	for (const line of text.split("\n")) {
		const next = line.trim() === "" ? null : lineSignature(line);
		if (next === null || next !== signature) {
			flush();
			signature = next;
		}
		if (next !== null) run.push(line);
	}
	flush();
	return found;
}
function totalNote(data, rowCount) {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return "";
	for (const name of TOTAL_FIELDS) if (typeof data[name] === "number" && data[name] > rowCount) return `, of ${data[name]}`;
	for (const name of MORE_FIELDS) if (data[name] === true) return ", more exist";
	if (data.next_offset !== void 0 && data.next_offset !== null) return ", more exist";
	return "";
}
function shortArgs(args) {
	if (args === null || typeof args !== "object") return "";
	const parts = [];
	for (const [name, value] of Object.entries(args)) {
		if (!isScalar(value)) continue;
		const text = String(value);
		parts.push(`${name}=${text.length > 90 ? `<${text.length} chars>` : text}`);
	}
	return parts.join(" ").slice(0, 220);
}
function extract(message, args) {
	const text = messageText(message);
	const data = parseJson(text);
	const lists = [];
	if (data !== void 0) jsonLists(data, "", 0, lists);
	else lists.push(...textLists(text));
	return lists.map((list) => {
		const columns = columnsOf(list.rows);
		const source = `${message.name ?? "tool"} ${list.field}${shortArgs(args) ? ` ${shortArgs(args)}` : ""}`;
		const hash = crypto.createHash("sha256").update(message.name ?? "").update(JSON.stringify(list.rows)).digest("hex");
		return {
			id: `D-${hash.slice(0, 6)}`,
			source,
			columns,
			rows: list.rows,
			note: totalNote(data, list.rows.length)
		};
	});
}
function handleLine(set) {
	const sample = set.columns.slice(0, 4).map((name) => `${name}=${String(set.rows[0][name] ?? "").slice(0, 40)}`).join(", ");
	return `[DATA ${set.id} | ${set.source} | ${set.rows.length} rows${set.note} | columns: ${set.columns.join(", ")} | first row: ${sample}]`;
}
/** Spalten, die eine Zeile kennzeichnen: fast nur verschiedene Werte, keine Statusspalten. */
function identifyingValues(set) {
	const values = /* @__PURE__ */ new Set();
	for (const name of set.columns) {
		const column = set.rows.map((row) => row[name]).filter((value) => typeof value === "string" && value.length >= 3);
		if (column.length < set.rows.length * .9 || new Set(column).size < column.length * .9) continue;
		for (const value of column) if (!/\s/.test(value)) values.add(value);
	}
	return values;
}
const TOKEN = /[^\s,;|`"'()[\]*:]+/g;
/** Entfernt nur vollstaendig abgetippte Mengen; eine gefilterte Teilmenge ist ein Ergebnis und bleibt. */
function stripTyped(content, set) {
	const values = identifyingValues(set);
	if (values.size < MIN_ROWS) return content;
	const needed = Math.ceil(set.rows.length * TYPED_SHARE);
	const lines = content.split("\n");
	const hits = lines.map((line) => [...line.matchAll(TOKEN)].filter((match) => values.has(match[0])));
	const separator = (line) => line.trim() === "" || /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
	for (let start = 0; start < lines.length; start++) {
		if (hits[start].length === 0) continue;
		let end = start;
		for (let next = start + 1; next < lines.length; next++) {
			if (hits[next].length > 0) end = next;
			else if (!separator(lines[next])) break;
		}
		const distinct = new Set();
		for (let index = start; index <= end; index++) for (const match of hits[index]) distinct.add(match[0]);
		if (distinct.size >= needed) {
			const structured = (line) => /^\s*([-*•|]|\d+[.)])/.test(line);
			const first = hits[start][0];
			const lastHits = hits[end];
			const last = lastHits[lastHits.length - 1];
			const before = structured(lines[start]) ? "" : lines[start].slice(0, first.index);
			const after = structured(lines[end]) ? "" : lines[end].slice(last.index + last[0].length);
			const note = `${before}[${distinct.size} rows, see ${set.id}]${after}`;
			lines.splice(start, end - start + 1, note);
			hits.splice(start, end - start + 1, []);
		}
	}
	return lines.join("\n");
}
/** Wird am Ende jedes Subagenten aufgerufen: speichert Listen, ersetzt sie im Text, haengt Griffe an. */
async function collect({ content, messages, user, conversationId }) {
	if (!user || !conversationId) return content;
	const argsByCall = /* @__PURE__ */ new Map();
	const sets = /* @__PURE__ */ new Map();
	for (const message of messages) {
		if (message._getType() === "ai") for (const call of message.tool_calls ?? []) argsByCall.set(call.id, call.args);
		if (message._getType() !== "tool") continue;
		for (const set of extract(message, argsByCall.get(message.tool_call_id))) sets.set(set.id, set);
	}
	if (sets.size === 0) return content;
	const col = collection();
	await indexReady;
	const now = Date.now();
	const stored = [];
	for (const set of [...sets.values()].slice(-MAX_HANDLES)) {
		if (Buffer.byteLength(JSON.stringify(set.rows)) > MAX_STORED_BYTES) continue;
		await col.updateOne({ id: set.id, user: String(user), conversationId }, {
			$setOnInsert: {
				source: set.source,
				columns: set.columns,
				rows: set.rows,
				createdAt: new Date(now)
			},
			$set: { expiresAt: new Date(now + TTL_DAYS * 864e5) }
		}, { upsert: true });
		stored.push(set);
	}
	let text = content;
	for (const set of stored) text = stripTyped(text, set);
	return stored.length === 0 ? text : `${text}\n\n${stored.map(handleLine).join("\n")}`;
}
function formatRows(set, wanted) {
	const columns = wanted.length > 0 ? wanted : set.columns;
	if (columns.length === 1) return set.rows.map((row) => row[columns[0]] ?? "").join(", ");
	const escape = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
	return [`| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, ...set.rows.map((row) => `| ${columns.map((name) => escape(row[name])).join(" | ")} |`)].join("\n");
}
/** Setzt Verweise ein. Nur Daten desselben Nutzers und Chats sind erreichbar. */
/** Lange Listen gehoeren in ein Artefakt, nicht in den Chatverlauf. */
function artifactBlock(set, wanted, body) {
	const slug = [set.id, ...wanted].join("-").replace(/[^A-Za-z0-9-]/g, "_").slice(0, 60);
	return `\n\n:::artifact{identifier="daten-${slug}" type="text/markdown" title="${set.rows.length} Einträge"}\n\`\`\`\`\n${body.replace(/`{4,}/g, "```")}\n\`\`\`\`\n:::\n\n`;
}
async function expand(text, { user, conversationId, wrapAt }) {
	const unknown = [];
	const refs = [...text.matchAll(REF_PATTERN)];
	if (refs.length === 0) return { text, unknown };
	const col = collection();
	await indexReady;
	const replacements = /* @__PURE__ */ new Map();
	for (const ref of refs) {
		if (replacements.has(ref[0])) continue;
		const set = !user || !conversationId ? null : await col.findOne({ id: ref[1], user: String(user), conversationId });
		const wanted = (ref[2] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
		const missing = set ? wanted.filter((name) => !set.columns.includes(name)) : [];
		if (!set || missing.length > 0) {
			unknown.push(set ? `${ref[1]}: no column ${missing.join(", ")} (columns: ${set.columns.join(", ")})` : ref[1]);
			continue;
		}
		replacements.set(ref[0], { set, wanted, body: formatRows(set, wanted) });
	}
	return {
		text: text.replace(REF_PATTERN, (ref, _id, _columns, offset) => {
			const found = replacements.get(ref);
			if (!found) return ref;
			return found.set.rows.length > ARTIFACT_ROWS && wrapAt?.(offset) ? artifactBlock(found.set, found.wanted, found.body) : found.body;
		}),
		unknown
	};
}
const PARTIAL_REF = /\{(?:\{(?:d(?:a(?:t(?:a(?::[^{}\n]{0,200}\}?)?)?)?)?)?)?$/;
const ARTIFACT_ROWS = 100;
const ARTIFACT_MARK = /:::artifact\{|(?:^|\n):::[ \t]*(?=\n|$)/g;
const TABLE_TAIL = /(^|\n)\|[^\n]*(?:\n(?:\|[ :|-]*\n?)?)?$/;
const MODEL_HEADER_TABLE = /(\|[^\n]*\|[ \t]*\n\|[ :|-]+\|[ \t]*\n)\|[^\n]*\|\n\|(?:---\|)+\n/g;
const MODEL_HEADER_ARTIFACT = /(\|[^\n]*\|[ \t]*\n\|[ :|-]+\|[ \t]*\n)\n*(:::artifact\{[^\n]*\n````\n)\|[^\n]*\|\n\|(?:---\|)+\n/g;
/** Antworttext des Hauptagenten. Ein Verweis kann ueber mehrere Textstuecke verteilt ankommen. */
function createAnswerFilter() {
	const buffers = /* @__PURE__ */ new Map();
	const tails = /* @__PURE__ */ new Map();
	const insideArtifact = /* @__PURE__ */ new Map();
	const isInside = (id, text) => {
		let inside = insideArtifact.get(id) ?? false;
		for (const mark of ((tails.get(id) ?? "") + text).matchAll(ARTIFACT_MARK)) inside = mark[0].includes("artifact");
		return inside;
	};
	const track = (id, text) => {
		insideArtifact.set(id, isInside(id, text));
		tails.set(id, ((tails.get(id) ?? "") + text).slice(-16));
	};
	/** Verweis und ein davorstehender Tabellenkopf muessen im selben Stueck ankommen. */
	const holdFrom = (text) => {
		const partial = text.match(PARTIAL_REF);
		const end = partial ? partial.index : text.length;
		const header = text.slice(0, end).match(TABLE_TAIL);
		return header ? header.index + header[1].length : end;
	};
	/** Schreibt das Modell selbst einen Tabellenkopf vor den Verweis, gilt seiner statt des eingesetzten. */
	const mergeHeaders = (text) => text.replace(MODEL_HEADER_ARTIFACT, "\n$2$1").replace(MODEL_HEADER_TABLE, "$1");
	const render = async (id, text, metadata, graph) => {
		const result = await expand(text, {
			user: graph?.config?.configurable?.user_id,
			conversationId: metadata?.thread_id,
			wrapAt: (offset) => !isInside(id, text.slice(0, offset))
		});
		if (result.unknown.length > 0) console.error("[bosToolData] unknown reference in answer", result.unknown);
		let output = result.text;
		for (const problem of result.unknown) output = output.replace(new RegExp(`\\{\\{data:${problem.slice(0, 8)}[^{}\\n]*\\}\\}`, "g"), `[Daten ${problem.slice(0, 8)} nicht verfuegbar]`);
		if (text.includes("{{data:")) output = mergeHeaders(output);
		track(id, text);
		return output;
	};
	return {
		async filter(data, metadata, graph) {
			const parts = data?.delta?.content;
			if (!Array.isArray(parts) || parts.length !== 1 || parts[0]?.type !== "text" || typeof parts[0].text !== "string") return data;
			if (!buffers.has(data.id) && !/[{|]/.test(parts[0].text)) {
				track(data.id, parts[0].text);
				return data;
			}
			const combined = (buffers.get(data.id) ?? "") + parts[0].text;
			const start = holdFrom(combined);
			const ready = combined.slice(0, start);
			if (start < combined.length) buffers.set(data.id, combined.slice(start));
			else buffers.delete(data.id);
			if (ready === "") return null;
			return {
				...data,
				delta: {
					...data.delta,
					content: [{ ...parts[0], text: await render(data.id, ready, metadata, graph) }]
				}
			};
		},
		/** Rest am Ende einer Modellantwort, etwa eine einzelne schliessende Klammer ohne Verweis. */
		async flush(metadata, graph, emit) {
			for (const [id, text] of buffers) {
				buffers.delete(id);
				await emit({
					id,
					delta: { content: [{ type: "text", text: await render(id, text, metadata, graph) }] }
				});
			}
		}
	};
}
module.exports = { collect, expand, createAnswerFilter, extract, stripTyped, handleLine, messageText };
