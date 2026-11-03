"use strict";
/** BOS-Patch: Speichergrenze je Benutzer. Summe von `bytes` aller Dateien eines Benutzers in `files`
 *  (Hochladen, Codeausfuehrung, Bildgenerierung, Dateien aus Werkzeugen) hoechstens
 *  BOS_USER_STORAGE_LIMIT_BYTES, Vorgabe 1 GiB.
 *  - attach(schema): Mongoose-Middleware am Datei-Schema, faengt jeden Weg, der einen Eintrag mit `bytes`
 *    anlegt oder vergroessert; bei Ueberschreitung wird die schon geschriebene lokale Datei geloescht.
 *  - assertRoom(user, bytes): Pruefung vor dem Schreiben (Upload-Route, tool-files).
 *  - uploadGate: Express-Middleware nach multer, antwortet mit 413 und einer lesbaren Meldung. */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

/** Beim Aufruf gelesen: LibreChat laedt .env erst nach den Modulen. */
function limit() {
	const value = Number(process.env.BOS_USER_STORAGE_LIMIT_BYTES);
	return Number.isSafeInteger(value) && value > 0 ? value : 1024 ** 3;
}
const CODE = "BOS_STORAGE_QUOTA";
/** Lokale Ablage: Pfad in `filepath` -> Verzeichnis im Container (config/paths: imageOutput, uploads). */
const ROOTS = [["/images/", "/app/client/public/images/"], ["/uploads/", "/app/uploads/"]];

function sizeText(bytes) {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${Math.ceil(bytes / 1024)} KB`;
}
/** Dezimalkomma fuer die deutsche Meldung an den Benutzer. */
function de(text) {
	return text.replace(".", ",");
}
class StorageQuotaError extends Error {
	constructor(used, bytes) {
		super(`Speicherplatz voll: ${de(sizeText(used))} von ${de(sizeText(limit()))} belegt, die Datei braucht ${de(sizeText(bytes))}. Dateien löschen unter Einstellungen → Daten → Dateien verwalten.`);
		this.name = "StorageQuotaError";
		this.code = CODE;
		this.userErrorStatusCode = 413;
		this.used = used;
		this.limit = limit();
		this.bytes = bytes;
	}
}
function isQuotaError(error) {
	return error?.code === CODE;
}
function objectId(user) {
	const text = String(user?._id ?? user);
	return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}
/** Belegte Bytes eines Benutzers, ohne die Datei `excludeFileId`. */
async function used(model, user, excludeFileId) {
	const id = objectId(user);
	if (!id) return 0;
	const match = { user: id, bytes: { $gt: 0 } };
	if (excludeFileId) match.file_id = { $ne: excludeFileId };
	const [row] = await model.aggregate([{ $match: match }, { $group: { _id: null, bytes: { $sum: "$bytes" } } }]);
	return row?.bytes ?? 0;
}
function fileModel() {
	return mongoose.models.File;
}
async function assertRoom(user, bytes, excludeFileId) {
	const model = fileModel();
	if (!model || !(bytes > 0)) return;
	const total = await used(model, user, excludeFileId);
	if (total + bytes > limit()) throw new StorageQuotaError(total, bytes);
}
/** Lokale Datei eines abgelehnten Eintrags entfernen, nur innerhalb der Ablage und nur mit file_id im Namen. */
async function removeLocal(data) {
	const filepath = String(data?.filepath ?? "");
	if (data?.source && data.source !== "local") return;
	if (!data?.file_id || !filepath.includes(String(data.file_id))) return;
	for (const [prefix, root] of ROOTS) {
		if (!filepath.startsWith(prefix)) continue;
		const target = path.resolve(root, decodeURIComponent(filepath.slice(prefix.length)));
		if (!target.startsWith(root)) return;
		await fs.promises.unlink(target).catch(() => {});
		return;
	}
}
async function check(model, data) {
	const total = await used(model, data.user, data.file_id);
	if (total + data.bytes <= limit()) return;
	await removeLocal(data);
	throw new StorageQuotaError(total, data.bytes);
}
function attach(schema) {
	if (schema.__bosStorageQuota) return;
	schema.__bosStorageQuota = true;
	schema.pre("save", async function () {
		if (!(this.bytes > 0) || (!this.isNew && !this.isModified("bytes"))) return;
		await check(this.constructor, { user: this.user, file_id: this.file_id, bytes: this.bytes, filepath: this.filepath, source: this.source });
	});
	schema.pre(["findOneAndUpdate", "updateOne"], async function () {
		const update = this.getUpdate() ?? {};
		const fields = { ...update, ...update.$setOnInsert, ...update.$set };
		if (!(fields.bytes > 0)) return;
		const existing = await this.model.findOne(this.getFilter(), { user: 1, bytes: 1, file_id: 1, filepath: 1, source: 1 }).lean();
		if (existing && (existing.bytes ?? 0) >= fields.bytes) return;
		const user = fields.user ?? existing?.user;
		if (!user) return;
		await check(this.model, {
			user,
			file_id: fields.file_id ?? existing?.file_id ?? this.getFilter()?.file_id,
			bytes: fields.bytes,
			filepath: fields.filepath ?? existing?.filepath,
			source: fields.source ?? existing?.source
		});
	});
}
/** Nach multer: Upload ablehnen, bevor LibreChat ihn verarbeitet (Dateisuche, OCR). */
async function uploadGate(req, res, next) {
	try {
		if (req.file?.size > 0 && req.user?.id) await assertRoom(req.user.id, req.file.size);
		return next();
	} catch (error) {
		if (!isQuotaError(error)) return next(error);
		if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
		return res.status(413).json({ message: error.message, code: CODE });
	}
}

module.exports = { limit, attach, assertRoom, uploadGate, isQuotaError, sizeText, StorageQuotaError, used };
