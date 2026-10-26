"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var BASE = "/var/lib/webosbrew/b9-home-custom";
var CACHE = "/var/lib/webosbrew/b9-home-package-cache";

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safe(name) {
    return typeof name === "string" && /^[A-Za-z0-9._/-]+$/.test(name) &&
        name.charAt(0) !== "/" && name.split("/").indexOf("..") === -1;
}
function integer(value) { return typeof value === "number" && value >= 0 && value % 1 === 0; }
function patch(original, spec) {
    if (original.length !== spec.originalSize || sha(original) !== spec.originalSha256 ||
            !Array.isArray(spec.edits)) throw new Error("The TV firmware does not match the supported original: " + spec.name);
    var chunks = [];
    var cursor = 0;
    spec.edits.forEach(function (edit) {
        if (!integer(edit.at) || !integer(edit.remove) || edit.at < cursor ||
                edit.at + edit.remove > original.length || !Array.isArray(edit.pieces)) {
            throw new Error("Invalid firmware edit: " + spec.name);
        }
        chunks.push(original.slice(cursor, edit.at));
        edit.pieces.forEach(function (piece) {
            if (typeof piece.text === "string" && piece.copy === undefined) chunks.push(new Buffer(piece.text, "utf8"));
            else if (integer(piece.copy) && integer(piece.length) && piece.copy + piece.length <= original.length &&
                    piece.text === undefined) chunks.push(original.slice(piece.copy, piece.copy + piece.length));
            else throw new Error("Invalid firmware insertion: " + spec.name);
        });
        cursor = edit.at + edit.remove;
    });
    chunks.push(original.slice(cursor));
    var result = Buffer.concat(chunks);
    if (result.length !== spec.patchedSize || sha(result) !== spec.patchedSha256) {
        throw new Error("Generated firmware overlay checksum failed: " + spec.name);
    }
    return result;
}

function prepare(payload, targets, options) {
    options = options || {};
    var io = options.fileSystem || fs;
    function native(name) { return options.rootDirectory ? path.join(options.rootDirectory, name) : name; }
    function exists(name) {
        try { io.lstatSync(name); return true; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    function mkdir(name) {
        if (exists(name)) {
            var stat = io.lstatSync(name);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unowned firmware cache directory: " + name);
            return;
        }
        mkdir(path.dirname(name));
        io.mkdirSync(name, 448);
    }
    var manifestBytes = io.readFileSync(path.join(payload, "manifest.json"));
    var manifest = JSON.parse(manifestBytes.toString("utf8"));
    var recipeBytes = io.readFileSync(path.join(payload, "firmware-patches.json"));
    if (sha(recipeBytes) !== manifest.firmwareRecipeSha256) throw new Error("Firmware patch instructions were modified.");
    var recipe = JSON.parse(recipeBytes.toString("utf8"));
    if (recipe.format !== 1 || !Array.isArray(recipe.files) ||
            recipe.files.length !== Object.keys(targets).length) throw new Error("Invalid firmware patch inventory.");
    if (sha(io.readFileSync(native("/etc/starfish-release"))) !== manifest.releaseSha256) {
        throw new Error("Unsupported TV firmware. No configuration changed.");
    }
    var generated = {};
    recipe.files.forEach(function (spec) {
        if (!safe(spec.name) || !targets[spec.name] || generated["original/" + spec.name]) {
            throw new Error("Unsafe or duplicate firmware patch.");
        }
        generated["original/" + spec.name] = spec;
        generated["patched/" + spec.name] = spec;
    });
    var entries = {};
    manifest.files.forEach(function (entry) {
        if (!safe(entry.path) || entries[entry.path]) throw new Error("Unsafe or duplicate runtime file.");
        entries[entry.path] = entry;
        if (generated[entry.path]) {
            var spec = generated[entry.path];
            var kind = entry.path.indexOf("original/") === 0 ? "original" : "patched";
            if (entry.sha256 !== spec[kind + "Sha256"] || entry.size !== spec[kind + "Size"]) {
                throw new Error("Firmware manifest mismatch: " + entry.path);
            }
        } else {
            var file = path.join(payload, entry.path);
            if (!io.lstatSync(file).isFile() || sha(io.readFileSync(file)) !== entry.sha256 ||
                    io.statSync(file).size !== entry.size) throw new Error("Packaged runtime checksum failed: " + entry.path);
        }
    });
    Object.keys(generated).forEach(function (name) {
        if (!entries[name]) throw new Error("Missing generated firmware file: " + name);
    });
    var cache = native(CACHE + "/" + sha(manifestBytes));
    if (exists(path.join(cache, "manifest.json"))) {
        var complete = io.readFileSync(path.join(cache, "manifest.json")).equals(manifestBytes) &&
            manifest.files.every(function (entry) {
                var file = path.join(cache, entry.path);
                return exists(file) && !io.lstatSync(file).isSymbolicLink() &&
                    io.lstatSync(file).isFile() && sha(io.readFileSync(file)) === entry.sha256;
            });
        if (complete) return cache;
    }
    if (exists(cache)) cache += "-" + Date.now() + "-" + process.pid;
    mkdir(cache);
    var output = {};
    recipe.files.forEach(function (spec) {
        var candidates = [native(BASE + "/original/" + spec.name), native(targets[spec.name])];
        var original = null;
        candidates.some(function (file) {
            if (!exists(file) || !io.lstatSync(file).isFile() || io.lstatSync(file).isSymbolicLink()) return false;
            var data = io.readFileSync(file);
            if (sha(data) !== spec.originalSha256 || data.length !== spec.originalSize) return false;
            original = data;
            return true;
        });
        if (!original) throw new Error("Cannot find the supported original TV firmware: " + spec.name);
        output["original/" + spec.name] = original;
        output["patched/" + spec.name] = patch(original, spec);
    });
    manifest.files.forEach(function (entry) {
        var target = path.join(cache, entry.path);
        mkdir(path.dirname(target));
        io.writeFileSync(target, output[entry.path] || io.readFileSync(path.join(payload, entry.path)),
            {flag: "wx", mode: entry.mode || 420});
    });
    io.writeFileSync(path.join(cache, "manifest.json"), manifestBytes, {flag: "wx", mode: 384});
    return cache;
}

module.exports = {prepare: prepare, patch: patch};
