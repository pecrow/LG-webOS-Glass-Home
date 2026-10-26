"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var cp = require("child_process");
var BASE = "/var/lib/webosbrew/b9-home-custom";
var HOOK = "/var/lib/webosbrew/init.d/30-b9-home-custom";
var ACTIVITY = "org.webosbrew.b9homecustom.startup";
var BOOSTER = "com.webos.applicationManager.supportQmlBooster";
var HOME_ROOT = "/usr/palm/applications/com.webos.app.fullhome/qml/";
var TARGETS = {
    "Containers/Main/TopShelf.qml": HOME_ROOT + "UserInterfaceLayer/Containers/Main/TopShelf.qml",
    "Containers/Main/MainRibbon.qml": HOME_ROOT + "UserInterfaceLayer/Containers/Main/MainRibbon.qml",
    "Containers/MainView.qml": HOME_ROOT + "UserInterfaceLayer/Containers/MainView.qml",
    "GlobalStyle.qml": HOME_ROOT + "UserInterfaceLayer/GlobalStyle.qml",
    "Model/ShelfList.js": HOME_ROOT + "Model/ShelfList.js",
    "main.qml": HOME_ROOT + "main.qml",
    "SystemSaverMainView.qml": "/usr/palm/applications/com.webos.app.screensaver/qml/Containers/MainView.qml",
    "YSM.qml": "/usr/lib/qt5/qml/YSM/YSM.qml"
};

function sha(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

function run(action, options) {
    options = options || {};
    var fs = options.fileSystem || require("fs");
    var requestedPayload = options.payloadDirectory || path.join(__dirname, "payload");
    if (fs.existsSync(path.join(requestedPayload, "firmware-patches.json"))) {
        if (options.uid !== undefined ? options.uid !== 0 : process.getuid() !== 0) {
            throw new Error("Rooted Homebrew Channel is required. No settings changed.");
        }
        var prepared = require("./bootstrap").prepare(requestedPayload, TARGETS, options);
        var configured = {};
        Object.keys(options).forEach(function (key) { configured[key] = options[key]; });
        configured.payloadDirectory = prepared;
        options = configured;
    }
    if (action === "status" || action === "restore") {
        return require("./restore").run(action, options, run("inspect", options), TARGETS);
    }
    if (["preflight", "apply", "inspect"].indexOf(action) === -1) {
        throw new Error("Usage: installer.js preflight|apply|status|restore");
    }
    var execute = options.execute || cp.execFileSync;
    var payload = options.payloadDirectory || path.join(__dirname, "payload");
    var manifestBytes = options.manifest ?
        new Buffer(JSON.stringify(options.manifest) + "\n", "utf8") :
        fs.readFileSync(path.join(payload, "manifest.json"));
    var manifest = JSON.parse(manifestBytes.toString("utf8"));
    var packageId = sha(manifestBytes);
    var entries = {};
    var mounted = {};
    var backup = null;

    function nativePath(name) {
        return options.rootDirectory ? path.join(options.rootDirectory, name) : name;
    }
    function exists(name) {
        try { fs.lstatSync(name); return true; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    function mkdir(name) {
        if (exists(name)) {
            if (!fs.lstatSync(name).isDirectory()) throw new Error("Not a directory: " + name);
            return;
        }
        mkdir(path.dirname(name));
        fs.mkdirSync(name, 493);
    }
    function read(name) { return fs.readFileSync(nativePath(name)); }
    function rpc(uri, value) {
        var result = JSON.parse(execute("/usr/bin/luna-send", [
            "-m", "com.webos.lunasend-homecustom", "-n", "1", "-w", "5000",
            "luna://" + uri, JSON.stringify(value)
        ], {encoding: "utf8", timeout: 7000}).toString());
        if (result.returnValue !== true) throw new Error(uri + ": " + JSON.stringify(result));
        return result;
    }
    function write(name, data, mode) {
        var target = nativePath(name);
        if (exists(target) && fs.lstatSync(target).isSymbolicLink()) {
            throw new Error("Refusing to replace a symbolic link: " + name);
        }
        if (exists(target) && fs.readFileSync(target).equals(data)) return;
        if (mounted[name]) throw new Error("Refusing to replace a mounted file: " + name);
        mkdir(path.dirname(target));
        var temporary = target + ".package-" + process.pid + "-" + Date.now();
        fs.writeFileSync(temporary, data, {flag: "wx", mode: mode || 420});
        fs.renameSync(temporary, target);
    }
    function originalHash(name) { return entries["original/" + name].sha256; }

    if (options.uid !== undefined ? options.uid !== 0 : process.getuid() !== 0) {
        throw new Error("Rooted Homebrew Channel is required. No settings changed.");
    }
    if (action !== "inspect" && exists(nativePath("/var/luna/preferences/webosbrew_failsafe"))) {
        throw new Error("Homebrew is in failsafe mode. Repair startup before installing Home.");
    }
    if (manifest.format !== 1 || !manifest.files || !manifest.general ||
            !manifest.option || Object.keys(manifest.option).length !== 1 ||
            manifest.option.quickStartMode !== "on" ||
            !manifest.configs || manifest.configs[BOOSTER] !== false) {
        throw new Error("Invalid Home package manifest.");
    }
    manifest.files.forEach(function (entry) {
        if (!/^[A-Za-z0-9._/-]+$/.test(entry.path) ||
                entry.path.split("/").indexOf("..") !== -1 || entries[entry.path]) {
            throw new Error("Unsafe or duplicate package path.");
        }
        var file = path.join(payload, entry.path);
        if (!fs.lstatSync(file).isFile() || fs.statSync(file).size !== entry.size ||
                sha(fs.readFileSync(file)) !== entry.sha256) {
            throw new Error("Package checksum failed: " + entry.path);
        }
        entries[entry.path] = entry;
    });
    Object.keys(TARGETS).forEach(function (name) {
        if (!entries["original/" + name] || !entries["patched/" + name]) {
            throw new Error("Missing native Home overlay: " + name);
        }
    });
    ["control.sh", "boot.sh", "startup.activity.json", "patched/LiveWallpaper.qml",
        "patched/DvdAnimation.qml", "patched/LgAnimation.qml", "patched/dvd-logo.png", "web/server.js", "web/storage.js",
        "web/video.js", "web/wake-home.js", "web/picture-context.js", "web/boot-policy.js",
        "web/idle-policy.js", "web/native-home.js",
        "web/public/index.html", "web/public/app.js", "web/public/image.js", "web/public/style.css",
        "web/data/settings.json", "web/data/background", "web/data/wallpaper.mp4"].forEach(function (name) {
        if (!entries[name]) throw new Error("Missing Home component: " + name);
    });
    if (sha(read("/etc/starfish-release")) !== manifest.releaseSha256) {
        throw new Error("Unsupported TV firmware. This package is for the captured B9 firmware.");
    }
    fs.readFileSync(nativePath("/proc/mounts"), "utf8").split("\n").forEach(function (line) {
        var parts = line.split(" ");
        if (parts[1]) mounted[parts[1]] = true;
    });
    var baseExists = exists(nativePath(BASE));
    if (baseExists) {
        var control = read(BASE + "/control.sh");
        var active = read(BASE + "/control.active.sha256").toString("utf8").trim().split(/\s+/);
        if (active[0] !== sha(control) || active[1] !== BASE + "/control.sh") {
            throw new Error("Existing Home controller is not owned or its checksum changed.");
        }
    }
    Object.keys(TARGETS).forEach(function (name) {
        var target = TARGETS[name];
        if (mounted[target]) {
            if (!baseExists || sha(read(BASE + "/original/" + name)) !== originalHash(name) ||
                    sha(read(target)) !== sha(read(BASE + "/patched/" + name))) {
                throw new Error("Another owner controls the native overlay: " + name);
            }
            if (sha(read(target)) !== entries["patched/" + name].sha256) {
                throw new Error("An older/different Home overlay is mounted. Roll it back before installing this build.");
            }
        } else if (sha(read(target)) !== originalHash(name)) {
            throw new Error("Native firmware file differs: " + name);
        }
    });
    if (exists(nativePath(HOOK)) && (!fs.lstatSync(nativePath(HOOK)).isSymbolicLink() ||
            fs.readlinkSync(nativePath(HOOK)) !== BASE + "/boot.sh")) {
        throw new Error("Another owner controls the Home startup hook.");
    }
    var settings = JSON.parse(fs.readFileSync(path.join(payload, "web/data/settings.json"), "utf8"));
    require(path.join(payload, "web/server.js")).validateSettings(settings);
    ["control.sh", "boot.sh"].forEach(function (name) {
        execute("/bin/sh", ["-n", path.join(payload, name)], {encoding: "utf8", timeout: 5000});
    });
    var currentGeneral = rpc("com.webos.settingsservice/getSystemSettings",
        {category: "general", keys: Object.keys(manifest.general)}).settings;
    var currentOption = rpc("com.webos.settingsservice/getSystemSettings",
        {category: "option", keys: ["quickStartMode"]}).settings;
    var currentConfigs = rpc("com.webos.service.config/getConfigs",
        {configNames: Object.keys(manifest.configs)}).configs;
    Object.keys(manifest.general).forEach(function (key) {
        if (!currentGeneral || typeof currentGeneral[key] !== "string") {
            throw new Error("Unsupported native Home preference: " + key);
        }
    });
    if (!currentConfigs || typeof currentConfigs[BOOSTER] !== "boolean") {
        throw new Error("Unsupported QML booster configuration.");
    }
    if (!currentOption || ["on", "off"].indexOf(currentOption.quickStartMode) === -1) {
        throw new Error("Unsupported Q Start+ preference.");
    }
    var optionRestore = {category: "option", settings: {quickStartMode: currentOption.quickStartMode}};
    if (exists(nativePath(BASE + "/settings.option.restore.json"))) {
        optionRestore = JSON.parse(read(BASE + "/settings.option.restore.json").toString("utf8"));
        if (optionRestore.category !== "option" || !optionRestore.settings ||
                Object.keys(optionRestore.settings).length !== 1 ||
                ["on", "off"].indexOf(optionRestore.settings.quickStartMode) === -1) {
            throw new Error("Invalid Q Start+ settings backup.");
        }
    }
    var activityDetails = JSON.parse(execute("/usr/bin/luna-send", [
        "-m", "com.webos.lunasend-homecustom", "-n", "1", "-w", "5000",
        "luna://com.palm.activitymanager/getDetails",
        JSON.stringify({activityName: ACTIVITY, current: true, internal: false})
    ], {encoding: "utf8", timeout: 7000}).toString());
    if (activityDetails.returnValue === true) {
        if (!activityDetails.activity || !activityDetails.activity.creator ||
                activityDetails.activity.creator.serviceId !== "com.webos.lunasend-homecustom") {
            throw new Error("Another owner controls the persistent Home startup activity.");
        }
    } else if (activityDetails.errorCode !== 2) {
        throw new Error("Cannot inspect the Home startup activity: " + JSON.stringify(activityDetails));
    }
    (action === "inspect" ? [] : ["WebAppMgr", "MaliitServer", "sam", "surface-manager"]).forEach(function (job) {
        if (!/start\/running/.test(execute("/sbin/initctl", ["status", job], {encoding: "utf8"}))) {
            throw new Error("Required UI service is stopped; leaving it stopped: " + job);
        }
    });
    var activity = JSON.parse(fs.readFileSync(path.join(payload, "startup.activity.json"), "utf8"));
    if (activity.activity.name !== ACTIVITY ||
            activity.activity.callback.method !== "luna://org.webosbrew.hbchannel.service/exec" ||
            activity.activity.callback.params.command !== BASE + "/control.sh boot >> " + BASE + "/boot.log 2>&1" ||
            activity.activity.trigger.where.prop.join("/") !== "signals/core-boot-done") {
        throw new Error("Invalid persistent Home boot activity.");
    }
    if (action === "inspect") {
        return {manifest: manifest, entries: entries, baseExists: baseExists,
            general: currentGeneral, option: currentOption, configs: currentConfigs,
            activity: activityDetails};
    }
    var policy = require(path.join(payload, "web/boot-policy.js"));
    var policyPath = exists(nativePath("/var/luna/preferences/bootd.json")) ?
        "/var/luna/preferences/bootd.json" : "/etc/palm/bootd.json";
    policy.preparePolicy(JSON.parse(read(policyPath).toString("utf8")));
    if (action === "preflight") {
        return {returnValue: true, compatible: true, existingHome: baseExists,
            packageId: packageId, files: manifest.files.length};
    }

    try {
        mkdir(nativePath(BASE));
        backup = BASE + "/package-backup-" + Date.now() + "-" + process.pid;
        fs.mkdirSync(nativePath(backup), 448);
        write(backup + "/native-before.json", new Buffer(JSON.stringify({
            general: currentGeneral, option: currentOption, configs: currentConfigs
        }) + "\n", "utf8"), 384);
        var previousFiles = manifest.files.filter(function (entry) {
            return entry.path.indexOf("web/data/") !== 0;
        }).map(function (entry) { return entry.path; }).concat([
            "settings.restore.json", "control.active.sha256", "boot-policy.backup.json",
            "package-installed.json", "activated-boot", "settings.config.restore.json",
            "settings.option.restore.json"
        ]);
        previousFiles.forEach(function (name) {
            if (exists(nativePath(BASE + "/" + name))) {
                write(backup + "/files/" + name, read(BASE + "/" + name), 384);
            }
        });
        write(backup + "/bootd.before.json", read(policyPath), 384);
        write(backup + "/manifest.json", manifestBytes, 384);
        var runtimeChanged = false;
        manifest.files.forEach(function (entry) {
            if (entry.path.indexOf("web/data/") === 0 && exists(nativePath(BASE + "/" + entry.path))) return;
            if (!exists(nativePath(BASE + "/" + entry.path)) ||
                    sha(read(BASE + "/" + entry.path)) !== entry.sha256) runtimeChanged = true;
            write(BASE + "/" + entry.path, fs.readFileSync(path.join(payload, entry.path)), entry.mode);
        });
        write(BASE + "/control.active.sha256", new Buffer(
            entries["control.sh"].sha256 + "  " + BASE + "/control.sh\n", "utf8"), 384);
        var restore = {category: "general", settings: {}};
        if (exists(nativePath(BASE + "/settings.restore.json"))) {
            restore = JSON.parse(read(BASE + "/settings.restore.json").toString("utf8"));
            if (restore.category !== "general" || !restore.settings) throw new Error("Invalid native settings backup.");
        }
        Object.keys(currentGeneral).forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(restore.settings, key)) {
                restore.settings[key] = currentGeneral[key];
            }
        });
        write(BASE + "/settings.restore.json", new Buffer(JSON.stringify(restore) + "\n", "utf8"), 384);
        write(BASE + "/settings.option.restore.json",
            new Buffer(JSON.stringify(optionRestore) + "\n", "utf8"), 384);
        if (currentOption.quickStartMode !== manifest.option.quickStartMode) {
            rpc("com.webos.settingsservice/setSystemSettings",
                {category: "option", settings: manifest.option, store: true, notify: true});
        }
        var appliedOption = rpc("com.webos.settingsservice/getSystemSettings",
            {category: "option", keys: ["quickStartMode"]}).settings;
        if (!appliedOption || appliedOption.quickStartMode !== manifest.option.quickStartMode) {
            throw new Error("Q Start+ preference did not persist.");
        }
        if (currentConfigs[BOOSTER] !== false) {
            if (!exists(nativePath(BASE + "/settings.config.restore.json"))) {
                write(BASE + "/settings.config.restore.json",
                    new Buffer(JSON.stringify({configs: currentConfigs}) + "\n", "utf8"), 384);
            }
            rpc("com.webos.service.config/setConfigs", {configs: manifest.configs});
        }
        if (rpc("com.webos.service.config/getConfigs", {configNames: [BOOSTER]}).configs[BOOSTER] !== false) {
            throw new Error("Required compositor configuration did not persist.");
        }
        rpc("com.webos.settingsservice/setSystemSettings", {category: "general", settings: manifest.general});
        var applied = rpc("com.webos.settingsservice/getSystemSettings",
            {category: "general", keys: Object.keys(manifest.general)}).settings;
        Object.keys(manifest.general).forEach(function (key) {
            if (applied[key] !== manifest.general[key]) throw new Error("Native preference did not persist: " + key);
        });
        policy.configure("apply", {base: nativePath(BASE),
            sourcePath: nativePath("/etc/palm/bootd.json"), targetPath: nativePath("/var/luna/preferences/bootd.json")});
        if (!exists(nativePath(HOOK))) {
            mkdir(path.dirname(nativePath(HOOK)));
            fs.symlinkSync(BASE + "/boot.sh", nativePath(HOOK));
        }
        rpc("com.palm.activitymanager/create", activity);
        write(BASE + "/activity.registered", new Buffer(ACTIVITY + "\n", "utf8"), 384);
        var boot = read("/proc/sys/kernel/random/boot_id").toString("utf8").trim();
        var ready = exists(nativePath(BASE + "/activated-boot")) &&
            read(BASE + "/activated-boot").toString("utf8").trim() === boot;
        if (runtimeChanged) {
            execute(nativePath(BASE + "/control.sh"), ["web-stop"], {encoding: "utf8", timeout: 12000});
            write(BASE + "/activated-boot", new Buffer("package-activation-pending\n", "utf8"), 384);
            ready = false;
        }
        if (ready) execute(nativePath(BASE + "/control.sh"), ["verify"], {encoding: "utf8", timeout: 12000});
        write(BASE + "/package-installed.json", new Buffer(JSON.stringify({
            packageId: packageId, version: manifest.version, backup: backup, installedAt: new Date().toISOString()
        }) + "\n", "utf8"), 384);
        var restoration = "/var/lib/webosbrew/b9-home-custom.restore.json";
        if (exists(nativePath(restoration))) {
            var record = JSON.parse(read(restoration).toString("utf8"));
            record.phase = "installed";
            write(restoration, new Buffer(JSON.stringify(record) + "\n", "utf8"), 384);
        }
        execute("/bin/sync", [], {encoding: "utf8", timeout: 10000});
        if (!ready) {
            if (options.activate) options.activate();
            else {
                var log = fs.openSync(nativePath(BASE + "/package-activation.log"), "a");
                try {
                    var child = cp.spawn("/bin/sh", ["-c", "sleep 3; exec " + BASE + "/control.sh boot"],
                        {detached: true, stdio: ["ignore", log, log]});
                    child.on("error", function (error) { console.error(error.stack); process.exitCode = 1; });
                    child.unref();
                } finally { fs.closeSync(log); }
            }
        }
        return {returnValue: true, installed: true, activationScheduled: !ready, backup: backup};
    } catch (error) {
        error.message += "\nInstallation did not finish. Preserved backup: " + backup;
        throw error;
    }
}

module.exports = {run: run, targets: TARGETS};
if (require.main === module) {
    try {
        var action = process.argv[2];
        if (action === "restore" && fs.existsSync(BASE)) {
            if (process.getuid() !== 0) throw new Error("Rooted Homebrew Channel is required. No settings changed.");
            console.log(cp.execFileSync("/usr/bin/flock", [
                "-x", BASE + "/control.lock", "/usr/bin/node", __filename, "restore-locked"
            ], {encoding: "utf8", timeout: 150000, maxBuffer: 1024 * 1024}).trim());
        } else {
            console.log(JSON.stringify(run(action === "restore-locked" ? "restore" : action)));
        }
    }
    catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
