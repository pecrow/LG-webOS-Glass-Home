"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var atomicWrite = require("./storage");
var LAST_INPUT = "{LAST_INPUT_APP}";

function preparePolicy(original) {
    var value = JSON.parse(JSON.stringify(original));
    var common = value.common;
    if (!value.inputApps || !common || !common.firstApp ||
            typeof common.firstApp.firstAppInNormal !== "string" ||
            typeof common.firstApp.firstAppInFirstUse !== "string" ||
            !common.firstAppByPowerOnReason ||
            typeof common.firstAppByPowerOnReason !== "object" ||
            Array.isArray(common.firstAppByPowerOnReason)) {
        throw new Error("This firmware has an unsupported boot policy. No boot settings changed.");
    }
    Object.keys(value).forEach(function (key) {
        if (key !== "common" && value[key] &&
                (value[key].firstApp || value[key].firstAppByPowerOnReason)) {
            throw new Error("Model-specific boot routing requires a compatibility review.");
        }
    });
    common.firstApp.firstAppInNormal = LAST_INPUT;
    Object.keys(common.firstAppByPowerOnReason).forEach(function (reason) {
        if (typeof common.firstAppByPowerOnReason[reason] !== "string") {
            throw new Error("Unrecognized power-on policy for " + reason);
        }
    });
    // Input placeholders are resolved by normal boot, not by reason-specific app launches.
    common.firstAppByPowerOnReason = {};
    return value;
}

function digest(value) {
    return value === null ? null : crypto.createHash("sha256").update(value).digest("hex");
}

function configure(action, options) {
    options = options || {};
    var base = options.base || path.dirname(__dirname);
    var sourcePath = options.sourcePath || "/etc/palm/bootd.json";
    var targetPath = options.targetPath || "/var/luna/preferences/bootd.json";
    var recordPath = path.join(base, "boot-policy.backup.json");
    var source = fs.readFileSync(sourcePath, "utf8");
    var current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
    var record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")) : null;
    if (!record) {
        if (action !== "apply") throw new Error("No managed boot policy to restore.");
        var desired = JSON.stringify(preparePolicy(JSON.parse(current === null ? source : current)), null, 2) + "\n";
        record = {
            version: 1, sourceDigest: digest(source),
            previous: current, previousDigest: digest(current),
            desired: desired, desiredDigest: digest(desired)
        };
        atomicWrite(recordPath, JSON.stringify(record) + "\n");
    }
    if (record.version !== 1 || digest(record.previous) !== record.previousDigest ||
            digest(record.desired) !== record.desiredDigest) {
        throw new Error("Invalid boot-policy backup; refusing to change startup.");
    }
    var superseded = record.supersededDigests || [];
    if (!Array.isArray(superseded) || superseded.some(function (value) {
        return typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value);
    })) throw new Error("Invalid managed boot-policy history.");
    var currentDigest = digest(current);
    var managed = currentDigest === record.desiredDigest || superseded.indexOf(currentDigest) !== -1;
    if (action === "apply") {
        if (record.sourceDigest !== digest(source)) {
            throw new Error("Firmware boot policy changed; review compatibility before applying.");
        }
        if (currentDigest !== record.previousDigest && !managed) {
            throw new Error("Another owner changed the boot policy; refusing to overwrite it.");
        }
        var next = JSON.stringify(preparePolicy(JSON.parse(record.previous === null ? source : record.previous)), null, 2) + "\n";
        if (record.desired !== next) {
            if (superseded.indexOf(record.desiredDigest) === -1) superseded.push(record.desiredDigest);
            record.supersededDigests = superseded;
            record.desired = next;
            record.desiredDigest = digest(next);
            atomicWrite(recordPath, JSON.stringify(record) + "\n");
        }
        atomicWrite(targetPath, record.desired);
        return "INPUT_FIRST_BOOT_POLICY_READY";
    }
    if (action === "rollback") {
        if (digest(current) === record.previousDigest) return "BOOT_POLICY_ALREADY_RESTORED";
        if (!managed) {
            throw new Error("Another owner changed the boot policy; refusing to overwrite it.");
        }
        if (record.previous !== null) {
            atomicWrite(targetPath, record.previous);
        } else {
            fs.renameSync(targetPath, path.join(base, "boot-policy.disabled." + Date.now() + ".json"));
        }
        return "BOOT_POLICY_RESTORED";
    }
    throw new Error("Usage: boot-policy.js apply|rollback");
}

module.exports = {preparePolicy: preparePolicy, configure: configure};

if (require.main === module) {
    if (["apply", "rollback"].indexOf(process.argv[2]) === -1) {
        throw new Error("Usage: boot-policy.js apply|rollback");
    }
    console.log(configure(process.argv[2]));
}
