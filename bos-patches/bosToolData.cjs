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
const MAX_SHOWN_CELL = 200;
const PAGE_ARGS = ["page", "offset", "start", "start_at", "startAt", "skip", "cursor", "next_page_token", "nextPageToken", "page_token", "pageToken"];
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
	const start = Math.min(...starts);
	const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
	if (end <= start) return void 0;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {}
	/** Beginnt der Text mit JSON, darf danach noch Text stehen, etwa "[instance: ...]" von trac-mcp. */
	if (text.slice(0, start).trim() !== "") return void 0;
	const close = text[start] === "{" ? "}" : "]";
	let candidate = text.lastIndexOf(close, end);
	for (let attempt = 0; attempt < 5 && candidate > start; attempt++) {
		try {
			return JSON.parse(text.slice(start, candidate + 1));
		} catch {}
		candidate = text.lastIndexOf(close, candidate - 1);
	}
	return void 0;
}
const isScalar = (value) => value === null || typeof value !== "object";
/** Zahlen, Wahrheitswerte und null bleiben, was sie sind: Code und Werkzeuge bekommen die Zeilen als JSON,
 *  und "false" als Text ist dort wahr. Nur Text wird gekuerzt. */
function cell(value) {
	if (value === null || value === void 0) return null;
	if (typeof value === "number" || typeof value === "boolean") return value;
	// Eine Liste einfacher Werte bleibt eine Liste: Code bekommt sie so, Antwort und Werkzeuge als "a, b".
	if (Array.isArray(value) && value.every(isScalar)) {
		if (JSON.stringify(value).length <= MAX_CELL) return value.map((item) => item ?? null);
		value = value.join(", ");
	}
	const text = typeof value === "object" ? JSON.stringify(value) : String(value);
	return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}...` : text;
}
/** Zelle als Text: eine Liste einfacher Werte durch Komma getrennt. */
const cellText = (value) => Array.isArray(value) ? value.map((item) => String(item ?? "")).join(", ") : String(value ?? "");
const isEmpty = (value) => value === "" || value === null || value === void 0;
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
	for (const row of rows.slice(0, 50)) for (const name of Object.keys(row)) if (!columns.includes(name) && rows.some((other) => !isEmpty(other[name]))) columns.push(name);
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
const PIPE_ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
function lineSignature(line) {
	const tabs = line.trim().match(/\t/g);
	if (tabs) return `tab${tabs.length}`;
	const prefix = line.match(/^\s*([-*•]|\d+[.)]|\|)\s/);
	if (prefix) return prefix[1].replace(/\d+/, "9");
	if (line.length > 120) return null;
	return line.trim().replace(/[\p{L}]+/gu, "a").replace(/\d+/g, "9").replace(/\s+/g, " ");
}
/** Zellen einer Tabellenzeile ("| a | b |") oder einer Zeile mit Tabulatoren, sonst null. */
function splitCells(line) {
	if (PIPE_ROW.test(line)) return line.trim().slice(1, -1).split(/(?<!\\)\|/).map((value) => value.trim().replace(/\\\|/g, "|"));
	if (line.trim().includes("\t")) return line.trim().split("\t").map((value) => value.trim());
	return null;
}
/** Spaltennamen aus einer Kopfzeile; leere oder doppelte Namen werden c1, c2, ... */
function columnNames(header, width) {
	const names = [];
	for (let index = 0; index < width; index++) {
		const name = String(header?.[index] ?? "").replace(/[{}:,]/g, " ").replace(/\s+/g, " ").trim();
		names.push(name !== "" && !names.includes(name) ? name : `c${index + 1}`);
	}
	return names;
}
/** Zeilen mit gleich vielen Zellen werden Spalten, mit Kopfzeile davor (Tabelle) oder c1, c2, ... */
function splitRows(lines, before) {
	let header = null;
	let body = lines;
	if (body.length > 1 && SEPARATOR_ROW.test(body[1]) && PIPE_ROW.test(body[0])) {
		header = splitCells(body[0]);
		body = body.slice(2);
	} else if (before.length >= 2 && SEPARATOR_ROW.test(before[1]) && PIPE_ROW.test(before[0])) header = splitCells(before[0]);
	body = body.filter((line) => !SEPARATOR_ROW.test(line));
	const cells = body.map(splitCells);
	const width = cells[0]?.length ?? 0;
	if (width < 2 || cells.some((row) => row === null || row.length !== width)) return null;
	const names = columnNames(header?.length === width ? header : null, width);
	return cells.map((row) => Object.fromEntries(names.map((name, index) => [name, cell(row[index])])));
}
const TRAILING_URL = /\s+[-–]\s+(https?:\/\/\S+)\s*$/;
const TRAILING_GROUP = /\s*\(([^()]*)\)\s*$/;
const FIELD_START = /,\s+(?=[\p{L}_][\p{L}\d_.-]*:(?:\s|$))/u;
const FIELD = /^\s*([\p{L}_][\p{L}\d_.-]*):(?:\s+([\s\S]*?)|\s*)\s*$/u;
const LINE_COLUMNS = ["id", "title", "url"];
/** "ID: Text (feld: wert, feld: wert) - URL" zerlegt, sonst null. Ein Doppelpunkt ohne Leerzeichen
 *  danach ("Datei.java:60") ist kein Feld. */
function lineFields(body) {
	let rest = body;
	let url = null;
	const urlMatch = rest.match(TRAILING_URL);
	if (urlMatch) {
		url = urlMatch[1];
		rest = rest.slice(0, urlMatch.index);
	}
	const fields = [];
	const group = rest.match(TRAILING_GROUP);
	if (group) {
		const parts = group[1].split(FIELD_START).map((part) => part.match(FIELD));
		if (parts.every(Boolean)) {
			for (const [, name, value] of parts) fields.push([name, value ?? ""]);
			rest = rest.slice(0, group.index);
		}
	}
	if (url === null && fields.length === 0) return null;
	const id = rest.trim().split(/\s+/)[0];
	const row = {
		id: id.replace(/^[#"'`]+|[:,;"'`]+$/g, ""),
		title: rest.trim().slice(id.length).replace(/^\s*[-–:]?\s*/, "")
	};
	for (const [name, value] of fields) {
		if (LINE_COLUMNS.includes(name) || name in row) return null;
		row[name] = cell(value.trim());
	}
	if (url !== null) row.url = url;
	return row;
}
/** Zeilen einer Folge als Spalten, wenn alle Zeilen dieselben Felder in derselben Reihenfolge haben.
 *  Die URL bleibt in den Zeilen als Linkziel der ersten Spalte, aber nicht als eigene Spalte. */
function fieldRows(bodies) {
	const rows = bodies.map(lineFields);
	if (rows.some((row) => row === null)) return null;
	const shape = Object.keys(rows[0]).join("\n");
	return rows.every((row) => Object.keys(row).join("\n") === shape) ? rows : null;
}
/** Textergebnisse: Folgen gleich aufgebauter Zeilen, etwa "- #123: ..." von Trac oder eine Tabelle aus Code. */
function textLists(text) {
	const found = [];
	const lines = text.split("\n");
	let run = [];
	let runStart = 0;
	let signature = null;
	const flush = () => {
		const before = lines.slice(Math.max(0, runStart - 2), runStart);
		const split = run.length >= MIN_ROWS ? splitRows(run, before) : null;
		if (split && split.length >= MIN_ROWS) found.push({ field: "table", rows: split });
		else if (run.length >= MIN_ROWS) {
			const bodies = run.map((line) => line.replace(/^\s*([-*•]|\d+[.)]|\|)\s+/, "").trim());
			const fields = fieldRows(bodies);
			found.push(fields ? { field: "lines", rows: fields, hidden: ["url"] } : {
				field: "lines",
				rows: bodies.map((body) => ({ id: body.split(/\s+/)[0].replace(/^[#"'`]+|[:,;"'`]+$/g, ""), line: body }))
			});
		}
		run = [];
	};
	lines.forEach((line, index) => {
		const next = line.trim() === "" ? null : lineSignature(line);
		if (next === null || next !== signature) {
			flush();
			signature = next;
			runStart = index;
		}
		if (next !== null) run.push(line);
	});
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
		const columns = columnsOf(list.rows).filter((name) => !list.hidden?.includes(name));
		const source = `${message.name ?? "tool"} ${list.field}${shortArgs(args) ? ` ${shortArgs(args)}` : ""}`;
		const hash = crypto.createHash("sha256").update(message.name ?? "").update(JSON.stringify(list.rows)).digest("hex");
		return {
			id: `D-${hash.slice(0, 6)}`,
			source,
			columns,
			rows: list.rows,
			note: totalNote(data, list.rows.length),
			pages: pageKey(message.name, list.field, args),
			total: totalOf(data)
		};
	});
}
/** Seiten derselben Abfrage (gleiches Werkzeug und gleiche Argumente bis auf page, offset, ...). */
function pageKey(tool, field, args) {
	if (args === null || typeof args !== "object" || !PAGE_ARGS.some((name) => name in args)) return null;
	const rest = Object.entries(args).filter(([name]) => !PAGE_ARGS.includes(name)).sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify([tool ?? "tool", field, rest]);
}
function totalOf(data) {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
	for (const name of TOTAL_FIELDS) if (typeof data[name] === "number") return data[name];
	return null;
}
/** Fuehrt die Seiten einer Abfrage zu einer Menge zusammen: Der Hauptagent setzt sie mit einem Verweis ein,
 *  und ab 100 Zeilen wird sie ein Artefakt. Gleiche Zeilen (eine Seite zweimal geholt) zaehlen einmal. */
function mergePages(sets) {
	const groups = /* @__PURE__ */ new Map();
	const out = [];
	for (const set of sets) {
		if (set.pages === null || set.pages === void 0) {
			out.push(set);
			continue;
		}
		if (!groups.has(set.pages)) {
			groups.set(set.pages, []);
			out.push(set.pages);
		}
		groups.get(set.pages).push(set);
	}
	return out.map((entry) => {
		if (typeof entry !== "string") return entry;
		const pages = groups.get(entry);
		if (pages.length === 1) return pages[0];
		const seen = /* @__PURE__ */ new Set();
		const rows = [];
		for (const page of pages) for (const row of page.rows) {
			const key = JSON.stringify(row);
			if (!seen.has(key)) {
				seen.add(key);
				rows.push(row);
			}
		}
		const last = pages[pages.length - 1];
		const total = pages.map((page) => page.total).find((value) => typeof value === "number") ?? null;
		const hash = crypto.createHash("sha256").update(entry).update(JSON.stringify(rows)).digest("hex");
		return {
			id: `D-${hash.slice(0, 6)}`,
			source: `${pages[0].source.replace(/ (page|offset|start|start_at|startAt|skip|cursor|next_page_token|nextPageToken|page_token|pageToken)=\S*/g, "")} pages=${pages.length}`,
			columns: [...new Set(pages.flatMap((page) => page.columns))].slice(0, MAX_COLUMNS),
			rows,
			note: total !== null ? total > rows.length ? `, of ${total}` : "" : last.note,
			pages: null,
			total
		};
	});
}
/** Spalten, die beim Einsetzen zu Links werden, geprueft an der ersten Zeile. */
function linkedColumns(set) {
	const row = set.rows[0] ?? {};
	return set.columns.filter((name) => {
		const url = cellText(row[name]) === "" ? null : linkOf(set, name, row);
		return Boolean(url) && /^https?:\/\/[^\s()]+$/.test(url);
	});
}
function handleLine(set) {
	const sample = set.columns.slice(0, 4).map((name) => `${name}=${cellText(set.rows[0][name]).slice(0, 40)}`).join(", ");
	const links = linkedColumns(set);
	return `[DATA ${set.id} | ${set.source} | ${set.rows.length} rows${set.note} | columns: ${set.columns.join(", ")}${links.length > 0 ? ` | links: ${links.join(", ")}` : ""} | first row: ${sample}]`;
}
/** Spalten, die eine Zeile kennzeichnen: fast nur verschiedene Werte, keine Statusspalten. */
function identifyingValues(set) {
	const values = /* @__PURE__ */ new Set();
	for (const name of set.columns) {
		const column = set.rows.map((row) => typeof row[name] === "number" || Array.isArray(row[name]) ? cellText(row[name]) : row[name]).filter((value) => typeof value === "string" && value.length >= 3);
		if (column.length < set.rows.length * .9 || new Set(column).size < column.length * .9) continue;
		for (const value of column) if (!/\s/.test(value)) values.add(value);
	}
	return values;
}
const TOKEN = /[^\s,;|`"'()[\]*:]+/g;
const plainCell = (value) => cellText(value).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
/** Mengen ohne kennzeichnende Spalte (Dateinamen mit Leerzeichen, mehrfach vorkommende Werte): Eine
 *  Tabellenzeile gehoert zur Menge, wenn alle ihre Zellen Werte derselben Zeile der Menge sind. */
function rowMatcher(set) {
	if (set.columns.length < 2 || set.rows.length < MIN_ROWS) return null;
	const rows = set.rows.map((row) => new Set(set.columns.map((name) => plainCell(row[name])).filter((value) => value !== "")));
	const byValue = /* @__PURE__ */ new Map();
	rows.forEach((values, index) => {
		for (const value of values) byValue.set(value, [...byValue.get(value) ?? [], index]);
	});
	return (line) => {
		const cells = (splitCells(line) ?? []).map(plainCell).filter((value) => value !== "");
		if (cells.length < 2) return -1;
		const longest = cells.reduce((a, b) => b.length > a.length ? b : a);
		const full = (byValue.get(longest) ?? []).find((index) => cells.every((value) => rows[index].has(value)));
		if (full !== void 0) return full;
		// Gekuerzte Zellen (Auszuege, Beschreibungen): Ein Wert, der nur in einer Zeile der Menge steht (ein
		// Pfad, ein Schluessel), bestimmt die Zeile.
		const unique = cells.map((value) => value.length >= 3 ? byValue.get(value) : void 0).find((indexes) => indexes?.length === 1);
		return unique ? unique[0] : -1;
	};
}
/** Entfernt nur vollstaendig abgetippte Mengen; eine gefilterte Teilmenge ist ein Ergebnis und bleibt. */
function stripTyped(content, set) {
	const values = identifyingValues(set);
	const matchRow = values.size < MIN_ROWS ? rowMatcher(set) : null;
	if (values.size < MIN_ROWS && matchRow === null) return content;
	const needed = Math.ceil(set.rows.length * TYPED_SHARE);
	const lines = content.split("\n");
	// Ein Satzzeichen am Wortende gehoert nicht zum Wert ("..., ABC-12.").
	const word = (match) => ({ index: match.index, text: match[0].replace(/[.!?]+$/, "") });
	const rowHit = (line) => {
		const index = matchRow(line);
		return index < 0 ? [] : [{ index: 0, text: `row ${index}` }];
	};
	const hits = lines.map((line) => matchRow ? rowHit(line) : [...line.matchAll(TOKEN)].map(word).filter((hit) => values.has(hit.text)));
	const separator = (line) => line.trim() === "" || /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
	const structured = (line) => /^\s*([-*•|]|\d+[.)])/.test(line);
	const blocks = [];
	for (let start = 0; start < lines.length; start++) {
		if (hits[start].length === 0) continue;
		let end = start;
		let blank = false;
		for (let next = start + 1; next < lines.length; next++) {
			if (hits[next].length > 0) {
				// Nach einer Leerzeile beginnt mit dem Wechsel zwischen Tabelle/Liste und Fliesstext ein neuer
				// Block: die Zeile "Fehlend: A, B." unter einer Tabelle ist eine Teilmenge und bleibt stehen.
				if (blank && structured(lines[next]) !== structured(lines[end])) break;
				end = next;
				blank = false;
			} else if (!separator(lines[next])) break;
			else if (lines[next].trim() === "") blank = true;
		}
		const distinct = new Set();
		for (let index = start; index <= end; index++) for (const hit of hits[index]) distinct.add(hit.text);
		blocks.push({ start, end, distinct });
		start = end;
	}
	const strip = blocks.filter((block) => block.distinct.size >= needed);
	// Seitenweise abgetippt: Tabellen oder Listen, die sich nicht ueberschneiden und zusammen die Menge
	// abdecken. Eine Teilmenge wiederholt Zeilen einer anderen Tabelle und bleibt deshalb stehen.
	const parts = blocks.filter((block) => !strip.includes(block) && block.distinct.size >= 2 && structured(lines[block.start]));
	const union = new Set(parts.flatMap((block) => [...block.distinct]));
	if (parts.length > 1 && union.size >= needed && union.size === parts.reduce((sum, block) => sum + block.distinct.size, 0)) strip.push(...parts);
	for (const block of strip.sort((a, b) => b.start - a.start)) {
		const { end, distinct } = block;
		let { start } = block;
		// Kopfzeile und Trennlinie einer ersetzten Tabelle gehen mit; sonst bleibt ein Tabellenrest stehen.
		const head = start >= 2 && SEPARATOR_ROW.test(lines[start - 1]) && PIPE_ROW.test(lines[start - 2]) && hits[start - 2].length === 0 ? 2 : 0;
		const first = hits[start][0];
		const lastHits = hits[end];
		const last = lastHits[lastHits.length - 1];
		const before = matchRow || structured(lines[start]) ? "" : lines[start].slice(0, first.index);
		const after = matchRow || structured(lines[end]) ? "" : lines[end].slice(last.index + last.text.length);
		const note = `${before}[${distinct.size} ${distinct.size === set.rows.length || parts.length < 2 || !parts.includes(block) ? "rows" : `of ${set.rows.length} rows`}, see ${set.id}]${after}`;
		lines.splice(start - head, end - start + 1 + head, note);
	}
	return lines.join("\n");
}
/** Eine Tabelle, die Code ohne Kopfzeile ausgibt, hat die Spalten c1, c2, ... Tippt der Subagent
 *  dieselben Zeilen mit Kopfzeile in seine Antwort, bekommt die Menge diese Namen: Der Hauptagent
 *  setzt sie sonst mit der Kopfzeile "c1 | c2 | c3" in seine Antwort ein. */
function nameColumns(content, set) {
	if (!set.columns.every((name, index) => name === `c${index + 1}`)) return set;
	const matchRow = rowMatcher(set);
	if (matchRow === null) return set;
	const lines = content.split("\n");
	const start = lines.findIndex((line, index) => index >= 2 && matchRow(line) >= 0 && SEPARATOR_ROW.test(lines[index - 1]) && PIPE_ROW.test(lines[index - 2]));
	if (start < 0) return set;
	const header = splitCells(lines[start - 2]).map(plainCell);
	if (header.length !== set.columns.length) return set;
	const names = columnNames(header, header.length);
	return {
		...set,
		columns: names,
		rows: set.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[set.columns[index]] ?? null])))
	};
}
/** Zahl der Spalten, deren Werte zur Haelfte im Text stehen: Welche Menge hat der Subagent abgetippt? */
function typedColumns(content, set) {
	let count = 0;
	for (const name of set.columns) {
		const values = set.rows.slice(0, 200).map((row) => cellText(row[name]).trim()).filter((value) => value.length >= 3 && value.length <= 200);
		if (values.length > 0 && values.filter((value) => content.includes(value)).length >= values.length / 2) count++;
	}
	return count;
}
/** Reihenfolge fuer stripTyped: die passendste Menge zuerst, bei Gleichstand die mit mehr Spalten. */
function rankForStrip(content, sets) {
	return sets.map((set, index) => ({ set, index, score: typedColumns(content, set) })).sort((a, b) => b.score - a.score || b.set.columns.length - a.set.columns.length || a.index - b.index).map(({ set }) => set);
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
	for (const found of mergePages([...sets.values()]).slice(-MAX_HANDLES)) {
		const set = nameColumns(content, found);
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
	for (const set of rankForStrip(text, stored)) text = stripTyped(text, set);
	return stored.length === 0 ? text : `${text}\n\n${stored.map(handleLine).join("\n")}`;
}
/** Ziel eines Werts im Antworttext: Ticket, Issue, Job oder Datei im System, aus dem die Zeile stammt. */
function linkOf(set, name, row) {
	const [, tool, server] = String(set.source ?? "").match(/^(\S*)_mcp_(\S+)/) ?? [];
	const value = cellText(row[name]);
	if (server === "trac" && tool.startsWith("ticket_") && (name === "id" || name === "key")) {
		return /^#?\d+$/.test(value) ? `http://tl.bos.local/trac/ticket/${value.replace("#", "")}` : null;
	}
	if (server === "trac" && tool.startsWith("milestone_") && (name === "id" || name === "name")) {
		// In Textzeilen ist id nur das erste Wort; ein Name mit Leerzeichen ("DPM 1.0") bleibt ohne Link.
		const line = row.line === void 0 ? null : String(row.line);
		const whole = line === null || line === value || line.startsWith(`${value} |`);
		return value === "" || !whole ? null : `http://tl.bos.local/trac/milestone/${encodeURIComponent(value)}`;
	}
	if (server === "jira-mercedes" && name === "key") {
		return /^[A-Z][A-Z0-9_]*-\d+$/.test(value) ? `https://mercedes-benz.atlassian.net/browse/${value}` : null;
	}
	// subject: Betreffzeilen eines Pushes aus list_user_activities, html_url zeigt auf Commit oder Vergleich.
	if (server === "gitea" && ["number", "full_name", "name", "subject"].includes(name)) return row.html_url || null;
	if (server === "nextcloud" && ["name", "path"].includes(name)) return row.url || null;
	if (server === "jenkins" && ["name", "fullname", "displayName", "number"].includes(name)) {
		// Jenkins nennt seine Stammadresse http://jenkins:8090/, die nur mit passendem Suchsuffix aufloest.
		return row.url ? String(row.url).replace(/^http:\/\/jenkins:8090\//, "http://jenkins.bos.local:8090/") : null;
	}
	// Zeilen mit Feldern: die URL der Zeile ist keine Spalte, sie verlinkt die erste Spalte.
	if (name === set.columns?.[0] && !set.columns.includes("url") && row.url) return String(row.url);
	return null;
}
function linked(set, name, row, text) {
	const url = text === "" ? null : linkOf(set, name, row);
	if (!url || !/^https?:\/\/[^\s()]+$/.test(url)) return text;
	return `[${text.replace(/[[\]]/g, "\\$&")}](${url})`;
}
/** Spalten fuer einen Verweis ohne Spaltenauswahl: ohne verschachtelte Werte (Listen, Objekte) und ohne
 *  URL-Spalten, deren Adresse schon als Link einer anderen Spalte derselben Zeile erscheint. Plan setzte
 *  die Gitea-Aktivitaeten mit rohem JSON in commits und html_url als nackter URL ein. */
function shownColumns(set) {
	const links = set.rows.map((row) => new Set(set.columns.map((name) => cellText(row[name]) === "" ? null : linkOf(set, name, row)).filter(Boolean)));
	const keep = set.columns.filter((name) => {
		const values = set.rows.map((row) => row[name]);
		// Listen von Texten (Pfade) bleiben, sie werden kommagetrennt; Objekte und Listen von Objekten nicht.
		// Die Zeilen speichern verschachtelte Werte als JSON-Text ("[{\"sha\":…}]"), nicht als Objekt.
		const parsed = (value) => {
			if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
			try {
				return JSON.parse(value);
			} catch {
				return value;
			}
		};
		const nested = (raw) => {
			const value = parsed(raw);
			return value !== null && typeof value === "object" && (!Array.isArray(value) || value.some((item) => item !== null && typeof item === "object"));
		};
		if (values.some(nested)) return false;
		const urls = values.map((value, index) => [cellText(value), index]).filter(([text]) => text !== "");
		return urls.length === 0 || !urls.every(([text, index]) => /^https?:\/\//.test(text) && links[index].has(text));
	});
	return keep.length > 0 ? keep : set.columns;
}
function formatRows(set, wanted) {
	const columns = wanted.length > 0 ? wanted : shownColumns(set);
	if (columns.length === 1) return set.rows.map((row) => linked(set, columns[0], row, cellText(row[columns[0]]))).join(", ");
	// Langtext (Auszuege, Beschreibungen) macht die Tabelle im Chat unlesbar breit; Code bekommt ihn ganz.
	const shown = (text) => text.length > MAX_SHOWN_CELL ? `${text.slice(0, MAX_SHOWN_CELL).trimEnd()} …` : text;
	const escape = (value) => shown(cellText(value).replace(/\s*\n\s*/g, " ")).replace(/\|/g, "\\|");
	return [`| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, ...set.rows.map((row) => `| ${columns.map((name) => linked(set, name, row, escape(row[name]))).join(" | ")} |`)].join("\n");
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
/** Mengen zu den Verweisen in Texten, nur fuer denselben Nutzer und einen der Chats. */
async function lookupRefs(texts, { user, conversationIds }) {
	const ids = [...new Set((conversationIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
	const found = /* @__PURE__ */ new Map();
	const unknown = [];
	const refs = [];
	for (const text of texts) for (const ref of text.matchAll(REF_PATTERN)) if (!refs.some((known) => known[0] === ref[0])) refs.push(ref);
	if (refs.length === 0) return { found, unknown };
	const col = collection();
	await indexReady;
	for (const ref of refs) {
		const set = !user || ids.length === 0 ? null : await col.findOne({ id: ref[1], user: String(user), conversationId: { $in: ids } });
		const wanted = (ref[2] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
		const missing = set ? wanted.filter((name) => !set.columns.includes(name)) : [];
		if (!set || missing.length > 0) unknown.push(set ? `${ref[1]}: no column ${missing.join(", ")} (columns: ${set.columns.join(", ")})` : ref[1]);
		else found.set(ref[0], { set, wanted });
	}
	return { found, unknown };
}
/** In Werkzeugargumenten: eine Spalte als kommagetrennte Liste, mehrere Spalten als JSON-Liste von Objekten.
 *  Enthaelt ein Wert ein Trennzeichen der Abgleichwerkzeuge (Komma, Semikolon, Zeilenumbruch), wird die
 *  Spalte eine JSON-Liste von Texten; sonst zerlegte das Werkzeug etwa einen Betreff "Angebot, Teil 2". */
function formatForTool(set, wanted) {
	const columns = wanted.length > 0 ? wanted : set.columns;
	if (columns.length === 1) {
		const values = set.rows.map((row) => cellText(row[columns[0]]));
		return values.some((value) => /[,;\r\n]/.test(value)) ? JSON.stringify(values) : values.join(", ");
	}
	return JSON.stringify(set.rows.map((row) => Object.fromEntries(columns.map((name) => [name, Array.isArray(row[name]) ? cellText(row[name]) : row[name] ?? null]))));
}
/** LibreChat speichert die Argumente nach dem Einsetzen: Im Verlauf steht /mnt/data/D-....json statt des
 *  Verweises, und das Modell schreibt den Pfad ab. In einer spaeteren Antwort gibt es die Datei nicht. Der
 *  Pfad der ganzen Menge wird deshalb wieder zum Verweis. Dateien einzelner Spalten bleiben: Ihr Name zeigt
 *  die Spaltenwahl nicht sicher, und im selben Lauf gibt es sie noch. */
const DATA_PATH = /\/mnt\/data\/(D-[0-9a-f]{6})\.json/g;
const dataPathRefs = (args) => mapStrings(args, (text) => text.replace(DATA_PATH, (path, id) => `{{data:${id}}}`));
function stringsOf(value, out = []) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
	else if (value !== null && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, out);
	return out;
}
function mapStrings(value, replace) {
	if (typeof value === "string") return replace(value);
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, replace));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapStrings(item, replace)]));
	return value;
}
/** BOS-Patch code-data-file: In der Codeausfuehrung wird ein Verweis zur JSON-Datei unter /mnt/data,
 *  {{data:D-...:spalte}} als Liste der Werte, sonst als Liste von Objekten. Eingesetzter Text muesste in
 *  Python- oder Shell-Strings richtig maskiert sein; ein \" in einem Wert wurde dort zu " und das JSON
 *  ungueltig. */
/** Eine Zelle, die eine Liste oder ein Objekt als JSON-Text haelt (cell() macht daraus Text, etwa die Sprints
 *  [{"name":...,"state":...}]), kommt in der Datei als Struktur zurueck. Nur Text, der mit [{ oder {" beginnt
 *  und sich vollstaendig lesen laesst; ein gekuerzter Wert bleibt Text. */
function structuredCell(value) {
	if (typeof value !== "string" || !(value.startsWith("[{") || value.startsWith("{\""))) return value;
	try {
		const parsed = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" ? parsed : value;
	} catch {
		return value;
	}
}
/** Eine Liste von Objekten nennt zu jeder Spalte, die im Antworttext ein Link wird, das Ziel im Feld
 *  <Spalte>_url. Sonst kennt Code die Adresse eines Tickets nicht und laesst den Link weg oder baut ihn selbst. */
function fileForCode(set, wanted) {
	const columns = wanted.length > 0 ? wanted : set.columns;
	const single = columns.length === 1 && wanted.length === 1;
	const links = single ? [] : linkedColumns(set).filter((name) => columns.includes(name) && !set.columns.includes(`${name}_url`));
	const target = (name, row) => {
		const url = cellText(row[name]) === "" ? null : linkOf(set, name, row);
		return url && /^https?:\/\/[^\s()]+$/.test(url) ? url : null;
	};
	const rows = single ? set.rows.map((row) => structuredCell(row[columns[0]] ?? null)) : set.rows.map((row) => ({
		...Object.fromEntries(columns.map((name) => [name, structuredCell(row[name] ?? null)])),
		...Object.fromEntries(links.map((name) => [`${name}_url`, target(name, row)]))
	}));
	return {
		name: `${[set.id, ...wanted].join("-").replace(/[^A-Za-z0-9-]/g, "_").slice(0, 80)}.json`,
		content: JSON.stringify(rows, null, 1)
	};
}
/** Setzt Verweise in die Argumente eines Werkzeugaufrufs ein, bevor das Werkzeug laeuft.
 *  So laufen Listen aus Griffen nie durch ein Modell. Mit upload (Codeausfuehrung) wird jeder Verweis
 *  als Datei hochgeladen und zu ihrem Pfad. */
async function expandArgs(args, scope, upload) {
	const texts = stringsOf(args).filter((text) => text.includes("{{data:"));
	if (texts.length === 0) return { args, unknown: [], codeFiles: [] };
	const { found, unknown } = await lookupRefs(texts, scope);
	if (unknown.length > 0) return { args, unknown, codeFiles: [] };
	const codeFiles = [];
	const paths = new Map();
	if (upload) for (const [ref, { set, wanted }] of found) {
		const file = fileForCode(set, wanted);
		const codeFile = await upload(file);
		codeFiles.push(codeFile);
		paths.set(ref, `/mnt/data/${codeFile.name}`);
	}
	const replace = (text) => text.replace(REF_PATTERN, (ref) => paths.get(ref) ?? formatForTool(found.get(ref).set, found.get(ref).wanted));
	return { args: mapStrings(args, replace), unknown, codeFiles };
}
/** Die juengsten Mengen der Chats, ohne ihre Zeilen zu laden. */
async function recentSets({ user, conversationIds }, exclude) {
	const ids = [...new Set((conversationIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
	if (!user || ids.length === 0) return [];
	const col = collection();
	await indexReady;
	const docs = await col.aggregate([
		{ $match: { user: String(user), conversationId: { $in: ids }, id: { $nin: [...exclude] } } },
		{ $sort: { createdAt: -1 } },
		{ $limit: MAX_HANDLES },
		{ $project: { id: 1, source: 1, columns: 1, count: { $size: "$rows" }, first: { $arrayElemAt: ["$rows", 0] } } }
	]).toArray();
	return docs.map((doc) => ({ id: doc.id, source: doc.source, columns: doc.columns, rows: Object.assign(new Array(doc.count), { 0: doc.first ?? {} }), note: "" }));
}
/** Auftrag an einen Subagenten: Verweise bleiben stehen, darunter je Menge ihre Zeile [DATA ...].
 *  Dazu die uebrigen juengsten Mengen des Chats: Vergisst der Hauptagent den Verweis ("diese 49 Schluessel"),
 *  findet der Subagent die Menge trotzdem. */
async function describeRefs(text, scope) {
	const { found, unknown } = await lookupRefs([text], scope);
	if (unknown.length > 0) return { text, unknown };
	const sets = [...new Map([...found.values()].map(({ set }) => [set.id, set])).values()];
	const others = await recentSets(scope, new Set(sets.map((set) => set.id)));
	const blocks = [];
	if (sets.length > 0) blocks.push(`Data references in this request: the system inserts the rows when a tool runs; pass each {{data:...}} unchanged in tool arguments or code, never type its rows.\n${sets.map((set) => handleLine({ ...set, note: "" })).join("\n")}`);
	if (others.length > 0) blocks.push(`Other data sets of this chat, newest first. If the request refers to items it does not list (for example "these keys" or "the tickets above") and exactly one set matches it (source and number of rows), take them from that set: write {{data:ID:column}} unchanged in tool arguments or code, never type its rows. If none or several match, do not guess: say which items are missing.\n${others.map(handleLine).join("\n")}`);
	return { text: blocks.length === 0 ? text : `${text}\n\n${blocks.join("\n\n")}`, unknown };
}
/** Verweis mit nur einer schliessenden Klammer, {{file:X} statt {{file:X}}. */
const LOOSE_REF = /\{\{(data|file):([^{}\n]+?)\}(?!\})/g;
/** Angefangener Verweis {{data:...}} oder {{file:...}} am Ende eines Textstuecks. */
const PARTIAL_REF = /\{(?:\{(?:(?:d(?:a(?:t(?:a)?)?)?|f(?:i(?:l(?:e)?)?)?)(?::[^{}\n]{0,200}\}?)?)?)?$/;
const ARTIFACT_ROWS = 100;
const ARTIFACT_MARK = /:::artifact\{|(?:^|\n):::[ \t]*(?=\n|$)/g;
const TABLE_TAIL = /(^|\n)\|[^\n]*(?:\n(?:\|[ :|-]*\n?)?)?$/;
const MODEL_HEADER_TABLE = /(\|[^\n]*\|[ \t]*\n\|[ :|-]+\|[ \t]*\n)\|[^\n]*\|\n\|(?:---\|)+\n/g;
const MODEL_HEADER_ARTIFACT = /(\|[^\n]*\|[ \t]*\n\|[ :|-]+\|[ \t]*\n)\n*(:::artifact\{[^\n]*\n````\n)\|[^\n]*\|\n\|(?:---\|)+\n/g;
/** Antworttext des Hauptagenten. Ein Verweis kann ueber mehrere Textstuecke verteilt ankommen. */
/** renderFiles: setzt {{file:...}} ein (bosToolFiles, Anhang der Antwort); fehlt es, bleibt der Verweis stehen. */
function createAnswerFilter({ renderFiles } = {}) {
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
	const render = async (id, raw, metadata, graph) => {
		const text = raw.replace(LOOSE_REF, "{{$1:$2}}");
		const result = await expand(text, {
			user: graph?.config?.configurable?.user_id,
			conversationId: metadata?.thread_id,
			wrapAt: (offset) => !isInside(id, text.slice(0, offset))
		});
		if (result.unknown.length > 0) console.error("[bosToolData] unknown reference in answer", result.unknown);
		let output = result.text;
		for (const problem of result.unknown) output = output.replace(new RegExp(`\\{\\{data:${problem.slice(0, 8)}[^{}\\n]*\\}\\}`, "g"), `[Daten ${problem.slice(0, 8)} nicht verfuegbar]`);
		if (text.includes("{{data:")) output = mergeHeaders(output);
		if (renderFiles && output.includes("{{file:")) output = await renderFiles(output, metadata, graph);
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
module.exports = { formatRows, shownColumns, cellText, mergePages, dataPathRefs, collect, expand, expandArgs, describeRefs, createAnswerFilter, extract, stripTyped, nameColumns, rankForStrip, handleLine, messageText };
