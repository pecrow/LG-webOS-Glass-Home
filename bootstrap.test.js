"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bootstrap = require("./bootstrap");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const original = Buffer.from("Item { property string name: 'factory'; }\n");
const inserted = "\n// Owned customization\n";
const patched = Buffer.concat([original, Buffer.from(inserted)]);
const spec = {
    name: "main.qml", originalSize: original.length, originalSha256: sha(original),
    patchedSize: patched.length, patchedSha256: sha(patched),
    edits: [{at: original.length, remove: 0, pieces: [{text: inserted}]}]
};
assert.deepEqual(bootstrap.patch(original, spec), patched);
assert.throws(() => bootstrap.patch(Buffer.from("other firmware"), spec), /firmware does not match/);
assert.throws(() => bootstrap.patch(original, {...spec, patchedSha256: "invalid"}), /checksum failed/);
assert.throws(() => bootstrap.patch(original, {...spec, edits: [{at: -1, remove: 0, pieces: []}]}), /Invalid firmware edit/);
assert.throws(() => bootstrap.patch(original, {...spec, edits: [
    {at: 0, remove: 0, pieces: [{copy: original.length, length: 1}]}
]}), /Invalid firmware insertion/);
const copySpec = {...spec, patchedSize: original.length, patchedSha256: sha(original),
    edits: [{at: 0, remove: original.length, pieces: [{copy: 0, length: original.length}]}]};
assert.deepEqual(bootstrap.patch(original, copySpec), original);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "glass-bootstrap-test-"));
try {
    const native = name => path.join(root, name);
    const payload = path.join(root, "public-payload");
    fs.mkdirSync(payload);
    fs.mkdirSync(path.dirname(native("/etc/starfish-release")), {recursive: true});
    fs.writeFileSync(native("/etc/starfish-release"), "fixture");
    const target = "/usr/palm/applications/com.webos.app.fullhome/qml/main.qml";
    fs.mkdirSync(path.dirname(native(target)), {recursive: true});
    fs.writeFileSync(native(target), original);
    const recipe = Buffer.from(JSON.stringify({format: 1, files: [spec]}));
    const owned = Buffer.from("Owned application source\n");
    const manifest = {
        releaseSha256: sha(Buffer.from("fixture")), firmwareRecipeSha256: sha(recipe),
        files: [
            {path: "original/main.qml", size: original.length, sha256: sha(original)},
            {path: "patched/main.qml", size: patched.length, sha256: sha(patched)},
            {path: "control.sh", size: owned.length, sha256: sha(owned)}
        ]
    };
    fs.writeFileSync(path.join(payload, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(payload, "firmware-patches.json"), recipe);
    fs.writeFileSync(path.join(payload, "control.sh"), owned);
    const targets = {"main.qml": target};
    const options = {rootDirectory: root};
    const cache = bootstrap.prepare(payload, targets, options);
    assert.deepEqual(fs.readFileSync(path.join(cache, "original/main.qml")), original);
    assert.deepEqual(fs.readFileSync(path.join(cache, "patched/main.qml")), patched);
    assert.deepEqual(fs.readFileSync(path.join(cache, "control.sh")), owned);
    assert.equal(fs.existsSync(path.join(payload, "original")), false);
    assert.equal(bootstrap.prepare(payload, targets, options), cache, "A verified cache is reused");
    fs.writeFileSync(path.join(cache, "patched/main.qml"), "corrupt cache");
    const repaired = bootstrap.prepare(payload, targets, options);
    assert.notEqual(repaired, cache, "Damaged caches are retained instead of overwritten");
    assert.deepEqual(fs.readFileSync(path.join(repaired, "patched/main.qml")), patched);
    fs.writeFileSync(path.join(payload, "firmware-patches.json"), "{}");
    assert.throws(() => bootstrap.prepare(payload, targets, options), /instructions were modified/);
    fs.writeFileSync(path.join(payload, "firmware-patches.json"), recipe);
    fs.writeFileSync(path.join(payload, "control.sh"), "tampered runtime");
    assert.throws(() => bootstrap.prepare(payload, targets, options), /runtime checksum failed/);
    fs.writeFileSync(path.join(payload, "control.sh"), owned);
    fs.writeFileSync(native("/etc/starfish-release"), "other");
    assert.throws(() => bootstrap.prepare(payload, targets, options), /Unsupported TV firmware/);
} finally {
    fs.rmSync(root, {recursive: true, force: true});
}
console.log("PASS firmware-free bootstrap, checksums, bounds, cache recovery and original-only reconstruction");
