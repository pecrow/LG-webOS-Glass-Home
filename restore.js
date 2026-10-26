"use strict";

var path = require("path");
var crypto = require("crypto");
var BASE = "/var/lib/webosbrew/b9-home-custom";
var RECORD = "/var/lib/webosbrew/b9-home-custom.restore.json";
var HOOK = "/var/lib/webosbrew/init.d/30-b9-home-custom";
var ACTIVITY = "org.webosbrew.b9homecustom.startup";
var BOOSTER = "com.webos.applicationManager.supportQmlBooster";
var IDLE = "com.webos.surfacemanager.userActivityTimeout";
var SNAPSHOTS = ["/tmp/checkpoint/com.webos.app.fullhome", "/mnt/lg/cmn_data/checkpoint/com.webos.app.fullhome",
    "/tmp/checkpoint/com.webos.app.screensaver", "/mnt/lg/cmn_data/checkpoint/com.webos.app.screensaver"];

function digest(value) {
    return value === null ? null : crypto.createHash("sha256").update(value).digest("hex");
}

function run(action, options, inspected, targets) {
    var fs = options.fileSystem || require("fs");
    var execute = options.execute || require("child_process").execFileSync;
    var payload = options.payloadDirectory || path.join(__dirname, "payload");
    function native(name) { return options.rootDirectory ? path.join(options.rootDirectory, name) : name; }
    function exists(name) {
        try { fs.lstatSync(native(name)); return true; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    function read(name) { return fs.readFileSync(native(name), "utf8"); }
    function json(name) {
        if (fs.lstatSync(native(name)).isSymbolicLink()) throw new Error("Unexpected restoration symlink: " + name);
        return JSON.parse(read(name));
    }
    function write(name, value) {
        if (exists(name) && fs.lstatSync(native(name)).isSymbolicLink()) {
            throw new Error("Refusing to replace restoration symlink: " + name);
        }
        var temporary = native(name) + ".restore-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, JSON.stringify(value) + "\n", {flag: "wx", mode: 384});
        fs.renameSync(temporary, native(name));
    }
    function reply(method, value) {
        return JSON.parse(execute("/usr/bin/luna-send", [
            "-m", "com.webos.lunasend-homecustom", "-n", "1", "-w", "5000",
            "luna://" + method, JSON.stringify(value)
        ], {encoding: "utf8", timeout: 7000}).toString());
    }
    function rpc(method, value) {
        var result = reply(method, value);
        if (result.returnValue !== true) throw new Error(method + ": " + JSON.stringify(result));
        return result;
    }
    function mounts() {
        var result = {};
        read("/proc/mounts").split("\n").forEach(function (line) {
            var p = line.split(" ");
            if (p[1]) result[p[1]] = {source: p[0], type: p[2], options: p[3].split(",")};
        });
        return result;
    }
    function activity() {
        var value = reply("com.palm.activitymanager/getDetails",
            {activityName: ACTIVITY, current: true, internal: false});
        if (value.returnValue === true) {
            if (!value.activity || !value.activity.creator ||
                    value.activity.creator.serviceId !== "com.webos.lunasend-homecustom") {
                throw new Error("Another owner controls the Home startup activity.");
            }
        } else if (value.errorCode !== 2) throw new Error("Cannot verify Home startup activity: " + JSON.stringify(value));
        return value;
    }
    function ownedSnapshots() {
        var table = mounts();
        SNAPSHOTS.forEach(function (name) {
            var m = table[name];
            if (m && (m.source !== "b9-home-custom" || m.type !== "tmpfs" || m.options.indexOf("ro") === -1 ||
                    fs.readdirSync(native(name)).length)) {
                throw new Error("Another owner controls the Home snapshot: " + name);
            }
        });
    }
    function settingsRecord(name, category, allowed) {
        var value = json(BASE + "/" + name);
        if (!value || value.category !== category || !value.settings ||
                Array.isArray(value.settings) || !Object.keys(value.settings).length ||
                Object.keys(value.settings).some(function (key) {
                    return allowed.indexOf(key) === -1 || typeof value.settings[key] !== "string";
                })) throw new Error("Invalid restoration settings: " + name);
        return value.settings;
    }
    function verifyValues(method, field, expected, argument) {
        var value = rpc(method, argument)[field];
        if (!value || Object.keys(expected).some(function (key) { return value[key] !== expected[key]; })) {
            throw new Error("Restoration readback failed: " + method);
        }
    }
    function pidExists(pid) { return exists("/proc/" + pid + "/exe"); }
    function executable(pid) { return fs.readlinkSync(native("/proc/" + pid + "/exe")); }
    function homePids() {
        return fs.readdirSync(native("/proc")).filter(function (pid) {
            if (!/^[1-9][0-9]*$/.test(pid)) return false;
            try { return executable(pid) === "/usr/bin/com.webos.app.fullhome"; }
            catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
        });
    }
    function signal(pid, expected, name) {
        if (!pidExists(pid)) return;
        if (executable(pid) !== expected) throw new Error("Process ownership changed: " + pid);
        execute("/bin/kill", ["-" + name, pid], {encoding: "utf8", timeout: 3000});
    }
    function serverPid() {
        if (!exists(BASE + "/web/server.pid")) return;
        var pid = read(BASE + "/web/server.pid").trim();
        if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Invalid Home settings server PID.");
        if (!pidExists(pid)) return;
        var args = read("/proc/" + pid + "/cmdline").split("\u0000");
        if (executable(pid) !== "/usr/bin/node" || args[1] !== BASE + "/web/server.js") {
            throw new Error("Home server PID belongs to another process; leaving it untouched.");
        }
        return pid;
    }
    function stopServer() {
        var pid = serverPid();
        if (!pid) return;
        signal(pid, "/usr/bin/node", "TERM");
        for (var attempt = 0; attempt < 12 && pidExists(pid); attempt++) {
            if (executable(pid) !== "/usr/bin/node" ||
                    read("/proc/" + pid + "/cmdline").split("\u0000")[1] !== BASE + "/web/server.js") return;
            execute("/bin/sleep", ["1"], {timeout: 2000});
        }
        if (pidExists(pid)) throw new Error("Home settings server did not stop gracefully.");
    }
    function clearRuntimePolicies() {
        var name = BASE + "/idle-policy.restore.json";
        var idle = exists(name) ? json(name) : null;
        if (idle) {
            if (typeof idle.previous !== "number" || idle.previous <= 0 || idle.previous >= 2147483646 ||
                    idle.previous % 1) throw new Error("Invalid Home idle-policy journal.");
            var configs = rpc("com.webos.service.config/getConfigs", {configNames: [IDLE]}).configs;
            if (!configs || typeof configs[IDLE] !== "number") throw new Error("Cannot inspect native idle timeout.");
            if (configs[IDLE] === 2147483647 || configs[IDLE] === 2147483646) {
                var desired = {};
                desired[IDLE] = idle.previous;
                rpc("com.webos.service.config/setConfigs", {configs: desired});
                verifyValues("com.webos.service.config/getConfigs", "configs", desired, {configNames: [IDLE]});
            }
            write(name, null);
        }
        name = BASE + "/picture-context.restore.json";
        var picture = exists(name) ? json(name) : null;
        if (picture) {
            if (typeof picture.input !== "string" || !picture.input || picture.input === "default" ||
                    typeof picture.card !== "string") throw new Error("Invalid Home picture-context journal.");
            var input = rpc("com.webos.settingsservice/getSystemSettings",
                {category: "dimensionInfo", keys: ["input"]}).settings;
            var windows = rpc("com.webos.surfacemanager/getForegroundAppInfo", {}).foregroundAppInfo;
            if (!input || typeof input.input !== "string" || !Array.isArray(windows)) {
                throw new Error("Cannot inspect the native picture context.");
            }
            var cards = windows.filter(function (w) { return w.windowType === "_WEBOS_WINDOW_TYPE_CARD"; });
            if (cards.length > 1) throw new Error("Ambiguous native picture context.");
            if (input.input === "default" && (cards.length ? cards[0].appId : "") === picture.card) {
                rpc("com.webos.settingsservice/setSystemSettings",
                    {category: "dimensionInfo", settings: {input: picture.input}});
                verifyValues("com.webos.settingsservice/getSystemSettings", "settings", {input: picture.input},
                    {category: "dimensionInfo", keys: ["input"]});
            }
            write(name, null);
        }
    }
    function verifyStock(plan) {
        var table = mounts();
        Object.keys(targets).forEach(function (name) {
            if (table[targets[name]] || digest(fs.readFileSync(native(targets[name]))) !==
                    inspected.entries["original/" + name].sha256) throw new Error("Stock native file not restored: " + name);
        });
        if (SNAPSHOTS.some(function (name) { return table[name]; }) || exists(HOOK) || activity().returnValue === true) {
            throw new Error("Custom Home persistence is still active.");
        }
        verifyValues("com.webos.settingsservice/getSystemSettings", "settings", plan.general,
            {category: "general", keys: Object.keys(plan.general)});
        verifyValues("com.webos.settingsservice/getSystemSettings", "settings", plan.option,
            {category: "option", keys: ["quickStartMode"]});
        verifyValues("com.webos.service.config/getConfigs", "configs", plan.configs,
            {configNames: Object.keys(plan.configs)});
        var current = exists("/var/luna/preferences/bootd.json") ? read("/var/luna/preferences/bootd.json") : null;
        if (digest(current) !== plan.boot.previousDigest) throw new Error("Original boot policy did not restore.");
        var retained = exists(BASE) ? BASE : plan.archive;
        if (!exists(retained) || !fs.lstatSync(native(retained)).isDirectory() ||
                fs.lstatSync(native(retained)).isSymbolicLink()) throw new Error("Retained recovery data is missing.");
        ["idle-policy.restore.json", "picture-context.restore.json"].forEach(function (name) {
            if (exists(retained + "/" + name) && json(retained + "/" + name) !== null) {
                throw new Error("Runtime restoration journal is still active: " + name);
            }
        });
    }

    var record = exists(RECORD) ? json(RECORD) : null;
    var allowed = Object.keys(inspected.manifest.general).concat(["screenSaverEnabled", "noSignalScreenSaver"]);
    if (record && (record.version !== 1 || ["restoring", "restored", "installed"].indexOf(record.phase) === -1 ||
            !/^\/var\/lib\/webosbrew\/b9-home-custom-restored-[0-9]+-[0-9]+$/.test(record.archive) ||
            !record.general || !Object.keys(record.general).length ||
            Object.keys(record.general).some(function (key) {
                return allowed.indexOf(key) === -1 || typeof record.general[key] !== "string";
            }) || !record.option || Object.keys(record.option).length !== 1 ||
            ["on", "off"].indexOf(record.option.quickStartMode) === -1 ||
            !record.configs || Object.keys(record.configs).length !== 1 || typeof record.configs[BOOSTER] !== "boolean" ||
            !record.boot || (record.boot.previous !== null && typeof record.boot.previous !== "string") ||
            digest(record.boot.previous) !== record.boot.previousDigest)) {
        throw new Error("Invalid stock restoration record.");
    }
    ownedSnapshots();
    if (action === "status") {
        var state = inspected.baseExists ? record && record.phase === "restoring" ? "restore-needed" :
            exists(BASE + "/package-installed.json") ? "installed" : "incomplete" :
            record && record.phase !== "installed" ? record.phase === "restored" ? "restored" : "restore-needed" :
            "not-installed";
        if (state === "restored") verifyStock(record);
        return {returnValue: true, state: state, quickStartMode: inspected.option.quickStartMode,
            archive: record ? record.archive : null};
    }
    if (!inspected.baseExists) {
        if (!record || record.phase === "installed") throw new Error("No installed Glass Home configuration to restore.");
        verifyStock(record);
        record.phase = "restored";
        write(RECORD, record);
        execute("/bin/sync", [], {timeout: 10000});
        return {returnValue: true, restored: true, restartRequired: true, archive: record.archive};
    }
    if (!fs.lstatSync(native(BASE)).isDirectory() || fs.lstatSync(native(BASE)).isSymbolicLink()) {
        throw new Error("The Home runtime is not an owned directory.");
    }
    ["control.sh", "web/boot-policy.js", "web/storage.js"].forEach(function (name) {
        if (digest(fs.readFileSync(native(BASE + "/" + name))) !== inspected.entries[name].sha256) {
            throw new Error("Managed Home component changed: " + name);
        }
    });
    var general = settingsRecord("settings.restore.json", "general", allowed);
    if (exists(BASE + "/settings.idle.restore.json")) {
        var idleSettings = settingsRecord("settings.idle.restore.json", "general", allowed);
        Object.keys(idleSettings).forEach(function (key) { general[key] = idleSettings[key]; });
    }
    var option = settingsRecord("settings.option.restore.json", "option", ["quickStartMode"]);
    if (["on", "off"].indexOf(option.quickStartMode) === -1) throw new Error("Invalid original Q Start+ setting.");
    var configRecord = exists(BASE + "/settings.config.restore.json") ? json(BASE + "/settings.config.restore.json") : null;
    var configs = configRecord ? configRecord.configs : inspected.configs;
    if (!configs || Object.keys(configs).length !== 1 || typeof configs[BOOSTER] !== "boolean") {
        throw new Error("Invalid original QML booster configuration.");
    }
    var boot = json(BASE + "/boot-policy.backup.json");
    var currentPolicy = exists("/var/luna/preferences/bootd.json") ? read("/var/luna/preferences/bootd.json") : null;
    if (!boot || boot.version !== 1 || (boot.previous !== null && typeof boot.previous !== "string") ||
            typeof boot.desired !== "string" || digest(boot.previous) !== boot.previousDigest ||
            digest(boot.desired) !== boot.desiredDigest || boot.sourceDigest !== digest(read("/etc/palm/bootd.json")) ||
            !Array.isArray(boot.supersededDigests || []) ||
            [boot.previousDigest, boot.desiredDigest].concat(boot.supersededDigests || []).indexOf(digest(currentPolicy)) === -1) {
        throw new Error("Boot policy changed or its restoration record is invalid.");
    }
    serverPid();
    ["idle-policy.restore.json", "picture-context.restore.json"].forEach(function (name) {
        if (!exists(BASE + "/" + name)) return;
        var value = json(BASE + "/" + name);
        if (value && (name === "idle-policy.restore.json" ?
                typeof value.previous !== "number" || value.previous <= 0 || value.previous >= 2147483646 || value.previous % 1 :
                typeof value.input !== "string" || !value.input || value.input === "default" || typeof value.card !== "string")) {
            throw new Error("Invalid runtime restoration journal: " + name);
        }
    });
    if (record && record.phase === "restoring" &&
            (JSON.stringify(record.general) !== JSON.stringify(general) ||
            JSON.stringify(record.option) !== JSON.stringify(option) ||
            JSON.stringify(record.configs) !== JSON.stringify(configs) ||
            record.boot.previousDigest !== boot.previousDigest)) {
        throw new Error("Restoration journals changed; refusing to overwrite the recovery plan.");
    }
    var plan = record && record.phase === "restoring" ? record : {
        version: 1, phase: "restoring", archive: BASE + "-restored-" + Date.now() + "-" + process.pid,
        general: general, option: option, configs: configs, boot: boot
    };
    if (exists(plan.archive)) throw new Error("Restoration archive already exists while the runtime is active.");
    write(RECORD, plan);
    try {
        if (activity().returnValue === true) rpc("com.palm.activitymanager/cancel", {activityName: ACTIVITY});
        if (activity().returnValue === true) throw new Error("Home startup activity did not cancel.");
        if (exists(HOOK)) fs.renameSync(native(HOOK), native(BASE + "/hook.disabled." + Date.now()));
        stopServer();
        clearRuntimePolicies();
        if (homePids().length) rpc("com.webos.applicationManager/closeByAppId", {id: "com.webos.app.fullhome"});
        homePids().forEach(function (pid) { signal(pid, "/usr/bin/com.webos.app.fullhome", "TERM"); });
        if (homePids().length) execute("/bin/sleep", ["2"], {timeout: 3000});
        homePids().forEach(function (pid) { signal(pid, "/usr/bin/com.webos.app.fullhome", "KILL"); });
        if (homePids().length) throw new Error("Custom Home process did not close.");
        Object.keys(targets).forEach(function (name) {
            if (mounts()[targets[name]]) execute("/bin/umount", [targets[name]], {encoding: "utf8", timeout: 5000});
        });
        SNAPSHOTS.forEach(function (name) {
            if (mounts()[name]) execute("/bin/umount", [name], {encoding: "utf8", timeout: 5000});
        });
        require(path.join(payload, "web/boot-policy.js")).configure("rollback", {
            base: native(BASE), sourcePath: native("/etc/palm/bootd.json"), targetPath: native("/var/luna/preferences/bootd.json")
        });
        rpc("com.webos.settingsservice/setSystemSettings", {category: "general", settings: plan.general});
        rpc("com.webos.settingsservice/setSystemSettings", {category: "option", settings: plan.option, store: true, notify: true});
        rpc("com.webos.service.config/setConfigs", {configs: plan.configs});
        verifyStock(plan);
        // Removing the active path also prevents an already-queued boot command from reapplying Home.
        fs.renameSync(native(BASE), native(plan.archive));
        verifyStock(plan);
        if (exists(BASE)) throw new Error("The active Home runtime still exists.");
        plan.phase = "restored";
        write(RECORD, plan);
        execute("/bin/sync", [], {timeout: 10000});
        return {returnValue: true, restored: true, restartRequired: true, archive: plan.archive};
    } catch (error) {
        throw new Error("Stock restoration did not finish. Do not uninstall this app; retry Restore stock Home.\n" +
            error.message + "\nRecovery record: " + RECORD + "\nRetained data: " + (exists(BASE) ? BASE : plan.archive));
    }
}

module.exports = {run: run};
