"use strict";
/** BOS-Patch: Dateien zwischen den Systemen. Liefert ein Werkzeug eine Datei (Bild, eingebettete Ressource
 *  mit blob, oder JSON mit einem base64-Feld), speichert LibreChat sie als Datei des Chats und gibt dem
 *  Modell statt der Bytes eine Zeile [FILE F-... | Name | Typ | Groesse | Quelle]. Mit {{file:F-...}} (oder
 *  {{file:<Dateiname>}} fuer Anhaenge und Ergebnisse der Codeausfuehrung) setzt LibreChat die Datei vor
 *  einem Werkzeuglauf als base64 ein, in der Codeausfuehrung als Pfad unter /mnt/data. Im Antworttext wird
 *  der Verweis zum Anhang der Antwort. Das Modul kennt keine Werkzeuge. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
/** Speichergrenze je Benutzer (patches/storage-quota) */
const quota = require("/app/packages/data-schemas/dist/bosStorageQuota.cjs");

const COLLECTION = "bostoolfiles";
const TTL_DAYS = 30;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_LIST = 10;
const MAX_APPEND = 20;
/** Text bis zu dieser Groesse bleibt zusaetzlich zur [FILE]-Zeile lesbar im Ergebnis (Quelltext, CSV, Logs). */
const MAX_INLINE_TEXT = 100 * 1024;
const APP_ROOT = "/app";
const PUBLIC_ROOT = "/app/client/public";
const FILE_REF = /\{\{file:([^{}\n]+?)\}\}/g;
/** Vorlage statt Verweis, etwa {{file:<Name>}} in einem Auftrag: bleibt Text. */
const isPlaceholder = (inner) => /<[^<>]*>/.test(inner);
/** Pfad unter /mnt/data in der Antwort eines Subagenten. */
const DATA_PATH = /\/mnt\/data\/([^\s`'"()\[\]{}<>|,;*]+)/g;
const FILE_LINE = /\[FILE (F-[0-9a-f]{6}) \|[^\]\n]*\]/g;
const FIELDS = ["name", "mime", "size", "file_id"];
const BASE64_KEYS = ["content_base64", "data_base64", "base64"];
const EXT_MIME = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", xml: "application/xml",
	md: "text/markdown", html: "text/html", css: "text/css", js: "text/javascript", yaml: "application/yaml",
	yml: "application/yaml", log: "text/plain", java: "text/x-java", py: "text/x-python", sh: "text/x-sh",
	zip: "application/zip", mp4: "video/mp4", xls: "application/vnd.ms-excel", doc: "application/msword",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" };

let indexReady;
function collection() {
	const { connection } = require("mongoose");
	if (connection.readyState !== 1) throw new Error("MongoDB is not connected");
	const col = connection.collection(COLLECTION);
	indexReady ??= Promise.all([
		col.createIndex({ id: 1, user: 1, conversationId: 1 }, { unique: true }),
		col.createIndex({ user: 1, conversationId: 1, createdAt: -1 }),
		col.createIndex({ expiresAt: 1 })
	]);
	return col;
}
const fileModel = () => require("mongoose").models.File;

function safeName(name) {
	const base = path.basename(String(name ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
	return (base === "" || base === "." || base === ".." ? "datei" : base).slice(0, 180);
}
function mimeOf(name, given) {
	const clean = typeof given === "string" ? given.split(";")[0].trim().toLowerCase() : "";
	if (clean && clean !== "application/octet-stream") return clean;
	return EXT_MIME[path.extname(name).slice(1).toLowerCase()] ?? (clean || "application/octet-stream");
}
function sizeText(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
function handleLine(doc) {
	return `[FILE ${doc.id} | ${doc.name} | ${doc.mime} | ${sizeText(doc.size)} | ${doc.source}]`;
}
function diskPath(filepath) {
	return filepath.startsWith("/images/") ? path.join(PUBLIC_ROOT, filepath) : path.join(APP_ROOT, filepath);
}

/** Abgelaufene Dateien samt Datei auf der Platte und Eintrag in `files` entfernen. */
async function sweep(col) {
	const expired = await col.find({ expiresAt: { $lt: new Date() } }).limit(100).toArray();
	for (const doc of expired) {
		await fs.promises.unlink(doc.diskPath).catch(() => {});
		await fileModel()?.deleteOne({ file_id: doc.file_id }).catch(() => {});
		await col.deleteOne({ _id: doc._id });
	}
}

/** Speichert Bytes als Datei des Chats. Gleicher Inhalt im selben Chat ergibt denselben Griff. */
async function store({ user, conversationId, bytes, name, mime, source }) {
	const col = collection();
	await indexReady;
	const sha = crypto.createHash("sha256").update(bytes).digest("hex");
	const id = `F-${sha.slice(0, 6)}`;
	const existing = await col.findOne({ id, user: String(user), conversationId });
	if (existing) return existing;
	sweep(col).catch((error) => console.error("[bosToolFiles] sweep failed", error));
	await quota.assertRoom(user, bytes.length);
	const fileName = safeName(name);
	const type = mimeOf(fileName, mime);
	const file_id = crypto.randomUUID();
	/** Bilder und Videos unter /images: der Browser laedt sie dort mit dem Anmelde-Cookie, Videos auch abschnittsweise. */
	const dir = /^(image|video)\//.test(type) ? "images" : "uploads";
	const filepath = `/${dir}/${user}/${file_id}__${fileName}`;
	const target = diskPath(filepath);
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	await fs.promises.writeFile(target, bytes);
	const now = Date.now();
	const record = {
		user,
		file_id,
		conversationId,
		bytes: bytes.length,
		filename: fileName,
		filepath,
		object: "file",
		type,
		source: "local",
		context: "message_attachment",
		usage: 0,
		embedded: false
	};
	await fileModel().create(record);
	const doc = {
		id,
		user: String(user),
		conversationId,
		file_id,
		name: fileName,
		mime: type,
		size: bytes.length,
		sha256: sha,
		source: String(source ?? "tool"),
		filepath,
		diskPath: target,
		createdAt: new Date(now),
		expiresAt: new Date(now + TTL_DAYS * 864e5)
	};
	await col.insertOne(doc);
	return doc;
}

/** Hinweis statt Datei, wenn der Speicherplatz des Benutzers voll ist; andere Fehler gehen weiter. */
function quotaNote(name, error) {
	if (!quota.isQuotaError(error)) throw error;
	return `[${name}: ${quota.sizeText(error.bytes)}, not stored: the user's personal file storage is full (${quota.sizeText(error.used)} of ${quota.sizeText(error.limit)} used). Tell the user to delete files under Settings > Data > Manage files.]`;
}
/** Bytes als Text, wenn sie gueltiges UTF-8 ohne NUL-Zeichen sind, sonst null. */
function asText(bytes) {
	if (bytes.length > MAX_INLINE_TEXT || bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}
/** base64 ohne regulaeren Ausdruck ueber den ganzen Text: ein Ausdruck mit Wiederholung lief bei 8 MB in RangeError. */
function isBase64(text) {
	let end = text.length;
	while (end > 0 && text.charCodeAt(end - 1) === 61) end--;
	if (end === 0 || text.length - end > 2) return false;
	for (let i = 0; i < end; i++) {
		const c = text.charCodeAt(i);
		if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 95 || c === 45)) return false;
	}
	return true;
}
function decodeBase64(text) {
	if (typeof text !== "string" || text.length === 0) return null;
	const clean = text.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
	if (!isBase64(clean)) return null;
	const bytes = Buffer.from(clean, "base64");
	return bytes.length > 0 ? bytes : null;
}
/** base64-Feld eines Objekts: content_base64, data_base64, base64, oder content mit content_format/encoding base64. */
function base64Field(obj) {
	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
	for (const key of BASE64_KEYS) if (typeof obj[key] === "string" && obj[key].length > 0) return key;
	const format = String(obj.content_format ?? obj.encoding ?? obj.format ?? "").toLowerCase();
	if (format === "base64" && typeof obj.content === "string") return "content";
	if (typeof obj.content_type === "string" && /;\s*base64$/i.test(obj.content_type) && typeof obj.content === "string") return "content";
	return null;
}
function nameOf(obj, fallback) {
	const raw = obj.filename ?? obj.file_name ?? obj.name ?? (typeof obj.path === "string" ? obj.path : void 0) ?? fallback;
	return safeName(typeof raw === "string" ? decodeURIComponentSafe(raw) : fallback);
}
function decodeURIComponentSafe(text) {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}
function uriName(uri) {
	if (typeof uri !== "string" || uri === "") return void 0;
	const last = uri.split(/[?#]/)[0].split("/").filter(Boolean).pop();
	return last ? decodeURIComponentSafe(last) : void 0;
}

/** Sucht in einem JSON-Wert Objekte mit base64-Feld, speichert sie und ersetzt das Feld durch den Griff. */
async function captureJson(value, ctx, docs, depth = 0) {
	if (depth > 6 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		const out = [];
		for (const item of value) out.push(await captureJson(item, ctx, docs, depth + 1));
		return out;
	}
	const key = base64Field(value);
	if (key) {
		const bytes = decodeBase64(value[key]);
		if (bytes) {
			const replaced = { ...value };
			if (bytes.length > MAX_BYTES) replaced[key] = `[${sizeText(bytes.length)}, larger than ${sizeText(MAX_BYTES)}, not stored]`;
			else {
				const name = nameOf(value, `${ctx.tool}.bin`);
				let doc;
				try {
					doc = await store({ ...ctx, bytes, name, mime: value.mime_type ?? value.mimeType ?? value.content_type ?? value.contentType });
				} catch (error) {
					replaced[key] = quotaNote(name, error);
					ctx.notes += 1;
					return replaced;
				}
				docs.push(doc);
				/** as_file: true verlangt nur die [FILE]-Zeile, auch fuer Text (Kopie in den Chat fuer die Codeausfuehrung). */
				const asFile = value.as_file === true;
				delete replaced.as_file;
				const text = asFile ? null : asText(bytes);
				if (text === null) replaced[key] = handleLine(doc);
				else {
					// Text bleibt lesbar; die Datei geht ueber die [FILE]-Zeile weiter
					if (key === "content") replaced.content = text;
					else {
						delete replaced[key];
						replaced.text = text;
					}
					for (const field of ["encoding", "content_format", "format"]) if (typeof replaced[field] === "string") replaced[field] = "text";
					if (typeof replaced.content_type === "string") replaced.content_type = replaced.content_type.replace(/;\s*base64$/i, "");
					replaced.file = handleLine(doc);
				}
			}
			return replaced;
		}
	}
	const out = {};
	for (const [name, item] of Object.entries(value)) out[name] = await captureJson(item, ctx, docs, depth + 1);
	return out;
}
function parseJsonText(text) {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!/^[{[]/.test(trimmed) || !/base64/i.test(trimmed)) return void 0;
	try {
		return JSON.parse(trimmed);
	} catch {
		return void 0;
	}
}

/** Vor formatToolContent: Dateien im Ergebnis eines MCP-Werkzeugs speichern. Bilder bleiben fuer das Modell
 *  erhalten, binaere Ressourcen und base64-Felder werden durch die Zeile [FILE ...] ersetzt. */
async function capture(result, { user, conversationId, server, tool }) {
	if (!result || !user || !conversationId || typeof conversationId !== "string") return result;
	/** notes: Dateien, die wegen der Speichergrenze nicht gespeichert wurden; ihr Hinweis ersetzt die Bytes. */
	const ctx = { user: String(user), conversationId, source: `${tool}_mcp_${server}`, tool, notes: 0 };
	const docs = [];
	const content = [];
	let imageNumber = 0;
	try {
		for (const item of Array.isArray(result.content) ? result.content : []) {
			if (item?.type === "image" && typeof item.data === "string") {
				const bytes = decodeBase64(item.data);
				imageNumber += 1;
				if (bytes && bytes.length <= MAX_BYTES) {
					const ext = MIME_EXT[mimeOf("", item.mimeType)] ?? "bin";
					const name = item._meta?.filename ?? `${tool}-${imageNumber}.${ext}`;
					try {
						docs.push(await store({ ...ctx, bytes, name, mime: item.mimeType }));
					} catch (error) {
						content.push({ type: "text", text: quotaNote(name, error) });
						ctx.notes += 1;
					}
				}
				content.push(item);
				continue;
			}
			if (item?.type === "resource" && typeof item.resource?.blob === "string") {
				const bytes = decodeBase64(item.resource.blob);
				const name = item.resource._meta?.filename ?? uriName(item.resource.uri) ?? `${tool}.bin`;
				if (bytes && bytes.length <= MAX_BYTES) {
					try {
						const doc = await store({ ...ctx, bytes, name, mime: item.resource.mimeType });
						docs.push(doc);
						content.push({ type: "text", text: handleLine(doc) });
					} catch (error) {
						content.push({ type: "text", text: quotaNote(name, error) });
						ctx.notes += 1;
					}
				} else content.push({ type: "text", text: `[${name}: ${bytes ? sizeText(bytes.length) : "unreadable"}, not stored]` });
				continue;
			}
			if (item?.type === "text") {
				const parsed = parseJsonText(item.text);
				if (parsed !== void 0) {
					const before = docs.length;
					const notesBefore = ctx.notes;
					const replaced = await captureJson(parsed, ctx, docs);
					if (docs.length > before || ctx.notes > notesBefore) {
						content.push({ ...item, text: JSON.stringify(replaced, null, 2) });
						continue;
					}
				}
			}
			content.push(item);
		}
		if (result.structuredContent && typeof result.structuredContent === "object") {
			const before = docs.length;
			const known = new Set(docs.map((doc) => doc.id));
			const replaced = await captureJson(result.structuredContent, ctx, docs);
			result.structuredContent = replaced;
			const added = docs.slice(before).filter((doc) => !known.has(doc.id));
			if (added.length > 0) content.push({ type: "text", text: added.map(handleLine).join("\n") });
		}
	} catch (error) {
		console.error("[bosToolFiles] capture failed", error);
		return result;
	}
	if (docs.length === 0 && ctx.notes === 0) return result;
	const lines = [...new Map(docs.map((doc) => [doc.id, doc])).values()].map(handleLine);
	if (lines.length > 0) content.push({ type: "text", text: `Files stored by the system (pass {{file:ID}} unchanged in tool arguments, code or your answer; never type file contents):\n${lines.join("\n")}` });
	result.content = content;
	return result;
}

function scopeIds(conversationIds) {
	return [...new Set((conversationIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
}
function parseRef(inner) {
	const text = inner.trim();
	const match = text.match(/^(F-[0-9a-f]{6})(?::([a-z_]+))?$/);
	if (match) return { key: match[1], field: match[2] };
	const field = FIELDS.find((name) => text.endsWith(`:${name}`));
	return { key: field ? text.slice(0, -field.length - 1) : text, field };
}
/** Griff F-... oder Dateiname: zuerst gespeicherte Werkzeugdateien, dann Anhaenge und Ergebnisse der
 *  Codeausfuehrung desselben Chats (neueste zuerst). Ein Pfad wie /mnt/data/x.png zaehlt mit seinem Namen. */
async function resolve(key, scope) {
	const found = await resolveExact(key, scope);
	if (found || !key.includes("/")) return found;
	const name = key.slice(key.lastIndexOf("/") + 1);
	return name ? resolveExact(name, scope) : null;
}
async function resolveExact(key, { user, conversationIds }) {
	const ids = scopeIds(conversationIds);
	if (!user || ids.length === 0) return null;
	const col = collection();
	await indexReady;
	const scope = { user: String(user), conversationId: { $in: ids } };
	if (/^F-[0-9a-f]{6}$/.test(key)) return col.findOne({ ...scope, id: key });
	const byName = await col.find({ ...scope, name: key }).sort({ createdAt: -1 }).limit(1).toArray();
	if (byName.length > 0) return byName[0];
	const File = fileModel();
	if (!File) return null;
	/** Neueste Fassung: Ergebnisse der Codeausfuehrung haben kein createdAt, jeder Lauf legt einen eigenen Eintrag
	 *  mit demselben Namen an; updatedAt ist der Zeitpunkt des Laufs. */
	const file = await File.findOne({ user: String(user), conversationId: { $in: ids }, filename: key, source: "local" }).sort({ updatedAt: -1, createdAt: -1 }).lean();
	if (!file?.filepath) return null;
	return {
		id: key,
		user: String(user),
		conversationId: file.conversationId,
		file_id: file.file_id,
		name: file.filename,
		mime: mimeOf(file.filename, file.type),
		size: file.bytes,
		source: "chat",
		filepath: file.filepath,
		diskPath: diskPath(file.filepath)
	};
}
async function lookupAll(texts, scope) {
	const found = new Map();
	const unknown = [];
	for (const text of texts) for (const ref of text.matchAll(FILE_REF)) {
		if (found.has(ref[0]) || unknown.includes(ref[1]) || isPlaceholder(ref[1])) continue;
		const { key, field } = parseRef(ref[1]);
		if (field && !FIELDS.includes(field)) {
			unknown.push(`${ref[1]} (fields: ${FIELDS.join(", ")})`);
			continue;
		}
		const doc = await resolve(key, scope);
		if (!doc) unknown.push(key);
		else found.set(ref[0], { doc, field });
	}
	return { found, unknown };
}
function stringsOf(value, out = []) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
	else if (value !== null && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, out);
	return out;
}
async function mapStrings(value, replace) {
	if (typeof value === "string") return replace(value);
	if (Array.isArray(value)) return Promise.all(value.map((item) => mapStrings(item, replace)));
	if (value !== null && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await mapStrings(item, replace)])));
	return value;
}
async function readFile(doc) {
	const bytes = await fs.promises.readFile(doc.diskPath);
	if (bytes.length > MAX_BYTES) throw new Error(`${doc.name} is larger than ${sizeText(MAX_BYTES)}`);
	return bytes;
}

/** Werkzeugargumente: {{file:X}} wird zu base64 der Datei, {{file:X:name|mime|size|file_id}} zum Feld.
 *  Mit upload (Codeausfuehrung) wird die Datei hochgeladen und der Verweis zum Pfad unter /mnt/data. */
async function expandArgs(args, scope, upload) {
	const texts = stringsOf(args).filter((text) => text.includes("{{file:"));
	if (texts.length === 0) return { args, unknown: [], codeFiles: [] };
	const { found, unknown } = await lookupAll(texts, scope);
	if (unknown.length > 0) return { args, unknown, codeFiles: [] };
	const codeFiles = [];
	const uploaded = new Map();
	const valueFor = async ({ doc, field }) => {
		if (field === "name") return doc.name;
		if (field === "mime") return doc.mime;
		if (field === "size") return String(doc.size);
		if (field === "file_id") return doc.file_id;
		if (upload) {
			if (!uploaded.has(doc.file_id)) {
				const codeFile = await upload(doc);
				codeFiles.push(codeFile);
				uploaded.set(doc.file_id, `/mnt/data/${codeFile.name}`);
			}
			return uploaded.get(doc.file_id);
		}
		return (await readFile(doc)).toString("base64");
	};
	const replace = async (text) => {
		if (!text.includes("{{file:")) return text;
		let out = "";
		let last = 0;
		for (const ref of text.matchAll(FILE_REF)) {
			if (!found.has(ref[0])) continue;
			out += text.slice(last, ref.index) + await valueFor(found.get(ref[0]));
			last = ref.index + ref[0].length;
		}
		return out + text.slice(last);
	};
	return { args: await mapStrings(args, replace), unknown, codeFiles };
}

/** Juengste Dateien der Chats als Zeilen, ohne die genannten. */
async function recentLines(scope, exclude = new Set()) {
	const ids = scopeIds(scope.conversationIds);
	if (!scope.user || ids.length === 0) return [];
	const col = collection();
	await indexReady;
	const docs = await col.find({ user: String(scope.user), conversationId: { $in: ids }, id: { $nin: [...exclude] } }).sort({ createdAt: -1 }).limit(MAX_LIST).toArray();
	return docs.map(handleLine);
}
/** Auftrag an einen Subagenten: Verweise pruefen, ihre Zeilen und die juengsten Dateien des Chats anhaengen. */
async function describeRefs(text, scope) {
	const { found, unknown } = await lookupAll([text], scope);
	if (unknown.length > 0) return { text, unknown };
	const named = [...new Map([...found.values()].map(({ doc }) => [doc.id, doc])).values()];
	const others = await recentLines(scope, new Set(named.map((doc) => doc.id)));
	const blocks = [];
	if (named.length > 0) blocks.push(`Files in this request: the system inserts a file when a tool runs; pass each {{file:...}} unchanged in tool arguments or code, never type file contents.\n${named.map(handleLine).join("\n")}`);
	if (others.length > 0) blocks.push(`Other files of this chat, newest first. If the request refers to a file it does not name and exactly one file here matches it, pass {{file:ID}} unchanged; otherwise do not guess.\n${others.join("\n")}`);
	return { text: blocks.length === 0 ? text : `${text}\n\n${blocks.join("\n\n")}`, unknown };
}

/** Nennt ein Subagent eine Datei, die sein Code geschrieben hat, als Pfad /mnt/data/<Name>, wird daraus
 *  {{file:<Name>}}: Der Pfad gilt nur in seiner Sandbox, der Verweis auch beim Hauptagenten. Nur Namen, die
 *  eine Datei des Chats tragen. */
async function namePaths(content, scope) {
	if (!content.includes("/mnt/data/")) return content;
	let out = "";
	let last = 0;
	for (const match of content.matchAll(DATA_PATH)) {
		if (content.slice(Math.max(0, match.index - 7), match.index) === "{{file:") continue;
		const name = match[1].replace(/[.:]+$/, "");
		if (!name || !await resolveExact(name, scope)) continue;
		out += content.slice(last, match.index) + `{{file:${name}}}`;
		last = match.index + "/mnt/data/".length + name.length;
	}
	return out + content.slice(last);
}

/** Gemeinsamer Arbeitsordner: Jede Datei des Chats liegt fuer jeden Agenten unter /mnt/data/<Name>, je Name die
 *  neueste Fassung (Werkzeugdatei oder Datei in `files`). Nennt ein Codeaufruf so einen Pfad und fehlt die Datei in
 *  seiner Code-Sitzung oder hat der Chat seither eine neuere Fassung, wird sie vor dem Lauf hochgeladen. Ohne
 *  Verzeichnis im Namen; Dateien der Sandbox, die (noch) nicht zum Chat gehoeren, bleiben unberuehrt. */
const WORKSPACE_PREFIX = "/mnt/data/";
const WORKSPACE_NAME_CHAR = /[\w.\-À-ɏ]/;
/** Hochgeladene Fassungen: Datei-ID in der Code-API -> file_id der Datei des Chats (je Prozess, die neuesten 2000). */
const workspaceUploads = new Map();
function rememberUpload(codeFileId, fileId) {
	workspaceUploads.set(codeFileId, fileId);
	if (workspaceUploads.size > 2000) workspaceUploads.delete(workspaceUploads.keys().next().value);
}
/** Namen des Chats, die als /mnt/data/<Name> mit Wortgrenze im Text stehen, laengste zuerst. */
function namedPaths(texts, names) {
	const hits = new Set();
	for (const name of [...names].sort((a, b) => b.length - a.length)) {
		const needle = WORKSPACE_PREFIX + name;
		for (const text of texts) {
			let at = text.indexOf(needle);
			while (at >= 0) {
				const next = text.charAt(at + needle.length);
				if (next === "" || !WORKSPACE_NAME_CHAR.test(next)) {
					hits.add(name);
					break;
				}
				at = text.indexOf(needle, at + 1);
			}
			if (hits.has(name)) break;
		}
	}
	return [...hits];
}
/** Dateien des Chats ohne Verzeichnis im Namen: neueste Fassung je Name (latest) und der Zeitpunkt jeder Fassung,
 *  nach file_id und nach Datei-ID in der Code-API (Ergebnisse der Codeausfuehrung). */
async function chatFiles({ user, conversationIds }) {
	const ids = scopeIds(conversationIds);
	const latest = new Map();
	const timeByFileId = new Map();
	const timeByCodeId = new Map();
	if (!user || ids.length === 0) return { latest, timeByFileId, timeByCodeId };
	const put = (entry) => {
		if (!entry.name || entry.name.includes("/")) return;
		timeByFileId.set(entry.doc.file_id, entry.time);
		if (entry.codeFileId) timeByCodeId.set(entry.codeFileId, entry.time);
		const known = latest.get(entry.name);
		if (!known || entry.time > known.time) latest.set(entry.name, entry);
	};
	const col = collection();
	await indexReady;
	for (const doc of await col.find({ user: String(user), conversationId: { $in: ids } }).toArray()) put({ name: doc.name, time: new Date(doc.createdAt ?? 0).getTime(), codeFileId: null, doc });
	const File = fileModel();
	if (File) for (const file of await File.find({ user: String(user), conversationId: { $in: ids }, source: "local", filepath: { $exists: true } }, { filename: 1, file_id: 1, filepath: 1, bytes: 1, type: 1, conversationId: 1, updatedAt: 1, createdAt: 1, "metadata.codeEnvSource.file_id": 1 }).lean()) put({
		name: file.filename,
		time: new Date(file.updatedAt ?? file.createdAt ?? 0).getTime(),
		codeFileId: file.metadata?.codeEnvSource?.file_id ?? null,
		doc: {
			id: file.filename,
			user: String(user),
			conversationId: file.conversationId,
			file_id: file.file_id,
			name: file.filename,
			mime: mimeOf(file.filename, file.type),
			size: file.bytes,
			source: "chat",
			filepath: file.filepath,
			diskPath: diskPath(file.filepath)
		}
	});
	return { latest, timeByFileId, timeByCodeId };
}
/** Braucht die Sitzung die neueste Fassung? Fehlt der Name: ja. Hat sie eine Fassung, die der Chat kennt (Ergebnis
 *  oder Hochladen), und ist die neueste Fassung juenger: ja. Eine Fassung, die der Chat nicht kennt, hat die Sandbox
 *  selbst geschrieben, sie bleibt. */
function needsLatest(name, entry, files, chat) {
	const mine = (files ?? []).filter((file) => file?.name === name);
	if (mine.length === 0) return true;
	let known = false;
	for (const file of mine) {
		if (file.id === entry.codeFileId || workspaceUploads.get(file.id) === entry.doc.file_id) return false;
		const uploadedFrom = workspaceUploads.get(file.id);
		const time = chat.timeByCodeId.get(file.id) ?? (uploadedFrom == null ? void 0 : chat.timeByFileId.get(uploadedFrom));
		if (time == null) return false;
		if (time < entry.time) known = true;
	}
	return known;
}
/** Dateien des Chats, die ein Codeaufruf als Pfad nennt und deren neueste Fassung seiner Sitzung fehlt: hochladen
 *  und als codeFiles zurueckgeben. context = Code-Sitzung des Aufrufs. */
async function workspaceFiles(args, scope, context, upload) {
	const texts = stringsOf(args).filter((text) => text.includes(WORKSPACE_PREFIX));
	if (texts.length === 0) return { args, codeFiles: [] };
	const chat = await chatFiles(scope);
	const codeFiles = [];
	const renames = new Map();
	for (const name of namedPaths(texts, chat.latest.keys())) {
		const entry = chat.latest.get(name);
		if (!needsLatest(name, entry, context?.files, chat)) continue;
		const codeFile = await upload(entry.doc);
		rememberUpload(codeFile.id, entry.doc.file_id);
		codeFiles.push(codeFile);
		if (codeFile.name !== name) renames.set(WORKSPACE_PREFIX + name, WORKSPACE_PREFIX + codeFile.name);
	}
	if (renames.size > 0) args = await mapStrings(args, (text) => {
		let out = text;
		for (const [from, to] of renames) out = out.split(from).join(to);
		return out;
	});
	return { args, codeFiles };
}
/** read_file mit /mnt/data/<Name>: Name der Datei des Chats, wenn die Sitzung ihre neueste Fassung nicht hat. */
async function workspaceReadName(pathText, scope, context) {
	const text = String(pathText ?? "").trim();
	if (!text.startsWith(WORKSPACE_PREFIX)) return null;
	const name = text.slice(WORKSPACE_PREFIX.length);
	if (!name || name.includes("/")) return null;
	const chat = await chatFiles(scope);
	const entry = chat.latest.get(name);
	return entry && needsLatest(name, entry, context?.files, chat) ? name : null;
}

/** Ende eines Subagenten: Pfade unter /mnt/data werden Verweise (namePaths); Zeilen [FILE ...] aus seinen
 *  Werkzeugergebnissen, die in seiner Antwort fehlen, haengt das Modul an; die Dateien gehoeren danach zum
 *  Aufruf des Hauptagenten (toolCallId). */
async function collect({ content, messages, user, conversationId, parentToolCallId }) {
	if (!user || !conversationId) return content;
	content = await namePaths(content, { user, conversationIds: [conversationId] }).catch((error) => {
		console.error("[bosToolFiles] namePaths failed", error);
		return content;
	});
	const lines = new Map();
	for (const message of messages) {
		if (message._getType?.() !== "tool") continue;
		const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? "").join("\n") : "";
		for (const match of text.matchAll(FILE_LINE)) lines.set(match[1], match[0]);
	}
	if (lines.size === 0) return content;
	try {
		if (parentToolCallId) {
			const col = collection();
			await indexReady;
			await col.updateMany({ user: String(user), conversationId, id: { $in: [...lines.keys()] } }, { $set: { toolCallId: parentToolCallId } });
		}
	} catch (error) {
		console.error("[bosToolFiles] collect failed", error);
	}
	const missing = [...lines.entries()].filter(([id]) => !content.includes(id)).slice(-MAX_APPEND).map(([, line]) => line);
	return missing.length === 0 ? content : `${content}\n\n${missing.join("\n")}`;
}

/** Bild oder Video unter /images/ (statisch ausgeliefert, mit dem Anmelde-Cookie): Markdown-Bild, das der
 *  Client im Text anzeigt, ein Video als Spieler (Patch client-bundle). Sonst null. */
function inlineImage(doc) {
	const filepath = String(doc.filepath ?? "");
	if (!/^(image|video)\//.test(String(doc.mime ?? "")) || !filepath.startsWith("/images/")) return null;
	const url = encodeURI(filepath).replace(/\(/g, "%28").replace(/\)/g, "%29");
	const alt = String(doc.name ?? "").replace(/[\[\]\\]/g, "");
	return `![${alt}](${url})`;
}
/** Andere Datei mit file_id: Markdown-Link der Form files/<Benutzer>/<file_id>/<Name>. Der Client erkennt ihn
 *  (MarkdownAnchor) und laedt die Datei ueber /api/files/download/<Benutzer>/<file_id>; der letzte Teil ist
 *  der Name beim Speichern, ohne Leer- und Klammerzeichen, weil der Client nur bis zum ersten Leerzeichen liest. */
function downloadLink(doc) {
	if (!doc.file_id || !doc.user) return null;
	const name = String(doc.name ?? "datei");
	const urlName = encodeURIComponent(name.replace(/[\s()[\]<>]+/g, "_"));
	const text = name.replace(/[\[\]\\]/g, "");
	return `[${text}](/api/files/${encodeURIComponent(String(doc.user))}/${encodeURIComponent(doc.file_id)}/${urlName})`;
}
/** Antworttext: Bilder erscheinen als Markdown-Bild im Text, andere Dateien als Download-Link; nur ohne beides
 *  wird der Verweis zum Dateinamen und die Datei zum Anhang der Antwort (attach). */
async function renderAnswer(text, scope, attach) {
	if (!text.includes("{{file:")) return text;
	const { found } = await lookupAll([text], scope);
	let out = "";
	let last = 0;
	for (const ref of text.matchAll(FILE_REF)) {
		const entry = found.get(ref[0]);
		if (!entry && isPlaceholder(ref[1])) continue;
		let replacement = `[Datei ${parseRef(ref[1]).key} nicht verfuegbar]`;
		if (entry) {
			const { doc, field } = entry;
			if (field === "name") replacement = doc.name;
			else if (field === "mime") replacement = doc.mime;
			else if (field === "size") replacement = sizeText(doc.size);
			else if (inlineImage(doc)) replacement = inlineImage(doc);
			else if (downloadLink(doc)) replacement = downloadLink(doc);
			else {
				replacement = `„${doc.name}“`;
				await attach(doc).catch((error) => console.error("[bosToolFiles] attach failed", error));
			}
		}
		out += text.slice(last, ref.index) + replacement;
		last = ref.index + ref[0].length;
	}
	return out + text.slice(last);
}
async function fileRecord(doc) {
	return fileModel()?.findOne({ file_id: doc.file_id }).lean();
}

module.exports = { workspaceFiles, workspaceReadName, namePaths, capture, expandArgs, describeRefs, collect, renderAnswer, fileRecord, resolve, handleLine, store, FILE_REF };
