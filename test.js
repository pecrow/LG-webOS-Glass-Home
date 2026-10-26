"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const installer = require("./installer");
const payload = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(payload, "manifest.json"), "utf8"));
const BOOSTER = "com.webos.applicationManager.supportQmlBooster";
const BASE = "/var/lib/webosbrew/b9-home-custom";
let checks = 0;

function check(name, callback) {
    callback();
    checks++;
    console.log("PASS " + name);
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b9-home-package-test-"));
    const links = new Map();
    const fileSystem = Object.create(fs);
    fileSystem.symlinkSync = (target, link) => { links.set(link, target); };
    fileSystem.readlinkSync = name => links.has(name) ? links.get(name) : fs.readlinkSync(name);
    fileSystem.lstatSync = name => links.has(name) ?
        {isSymbolicLink: () => true, isDirectory: () => false} : fs.lstatSync(name);
    let interruptArchive = false;
    fileSystem.renameSync = (from, to) => {
        if (links.has(from)) { links.set(to, links.get(from)); links.delete(from); return; }
        fs.renameSync(from, to);
        for (const [name, value] of Array.from(links)) {
            if (name.startsWith(from + path.sep)) {
                links.set(to + name.slice(from.length), value);
                links.delete(name);
            }
        }
        if (interruptArchive && from === location(BASE)) {
            interruptArchive = false;
            throw new Error("Simulated interruption after retaining runtime");
        }
    };
    function location(name) { return path.join(root, name); }
    function write(name, value) {
        const target = location(name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, value);
    }
    const release = process.env.B9_TEST_RELEASE;
    assert.ok(release, "B9_TEST_RELEASE must be the exact captured firmware release");
    write("/etc/starfish-release", release);
    write("/proc/mounts", "");
    write("/proc/sys/kernel/random/boot_id", "test-boot\n");
    const policy = {inputApps: {HDMI_2: "com.webos.app.hdmi2"}, common: {
        firstApp: {firstAppInNormal: "{LAST_INPUT_APP}", firstAppInFirstUse: "com.palm.app.firstuse"},
        firstAppByPowerOnReason: {remoteKey: "{LAST_APP}"}
    }};
    write("/etc/palm/bootd.json", JSON.stringify(policy));
    fs.mkdirSync(location("/var/luna/preferences"), {recursive: true});
    Object.keys(installer.targets).forEach(name => {
        write(installer.targets[name], fs.readFileSync(path.join(payload, "original", name)));
    });
    let general = Object.assign({}, manifest.general, {homeAutoLaunch: "on"});
    let nativeOption = {quickStartMode: "off"};
    let ignoreOptionWrites = false;
    let rejectOptionWrites = false;
    let configs = {[BOOSTER]: true};
    let stopped = null;
    let reject = null;
    let activityOwner = null;
    let ignoreUmount = false;
    let ignoreConfigs = false;
    let dimension = {input: "HDMI_2"};
    let activated = 0;
    const calls = [];
    function execute(command, args) {
        calls.push({command, args});
        if (command === "/bin/umount") {
            if (ignoreUmount) return "";
            const name = Object.keys(installer.targets).find(name => installer.targets[name] === args[0]);
            if (name) write(args[0], fs.readFileSync(path.join(payload, "original", name)));
            write("/proc/mounts", fs.readFileSync(location("/proc/mounts"), "utf8")
                .split("\n").filter(line => line.split(" ")[1] !== args[0]).join("\n"));
            return "";
        }
        if (command === "/bin/kill") {
            links.delete(location("/proc/" + args[1] + "/exe"));
            return "";
        }
        if (command === "/sbin/initctl") {
            return args[1] + (args[1] === stopped ? " stop/waiting" : " start/running, process 123");
        }
        if (command === "/usr/bin/luna-send") {
            const uri = args[args.length - 2];
            const value = JSON.parse(args[args.length - 1]);
            if (uri === reject) return JSON.stringify({returnValue: false, errorText: "Fixture rejected request"});
            if (uri.endsWith("/getSystemSettings")) {
                return JSON.stringify({returnValue: true, settings: value.category === "option" ? nativeOption :
                    value.category === "dimensionInfo" ? dimension : general});
            }
            if (uri.endsWith("/setSystemSettings")) {
                if (value.category === "option") {
                    if (rejectOptionWrites) return JSON.stringify({returnValue: false, errorText: "Q Start+ write rejected"});
                    if (!ignoreOptionWrites) nativeOption = Object.assign({}, nativeOption, value.settings);
                } else if (value.category === "dimensionInfo") dimension = Object.assign({}, dimension, value.settings);
                else general = Object.assign({}, general, value.settings);
            }
            if (uri.endsWith("/getConfigs")) return JSON.stringify({returnValue: true, configs:
                Object.fromEntries(value.configNames.filter(key => key in configs).map(key => [key, configs[key]]))});
            if (uri.endsWith("/setConfigs") && !ignoreConfigs) configs = Object.assign({}, configs, value.configs);
            if (uri.endsWith("/create")) activityOwner = "com.webos.lunasend-homecustom";
            if (uri.endsWith("/cancel")) activityOwner = null;
            if (uri.endsWith("/getForegroundAppInfo")) return JSON.stringify({returnValue: true, foregroundAppInfo: [
                {appId: "org.webosbrew.b9homecustom", windowType: "_WEBOS_WINDOW_TYPE_CARD"}
            ]});
            if (uri.endsWith("/getDetails")) {
                return JSON.stringify(activityOwner ? {returnValue: true, activity: {creator: {
                    serviceId: activityOwner
                }}} : {returnValue: false, errorCode: 2});
            }
            return JSON.stringify({returnValue: true});
        }
        return "";
    }
    const options = {
        uid: 0, rootDirectory: root, fileSystem, execute, payloadDirectory: payload,
        activate: () => { activated++; }
    };
    return {root, options, write, location, calls, links,
        stop: job => { stopped = job; }, reject: uri => { reject = uri; },
        owner: value => { activityOwner = value; },
        activated: () => activated, configs: () => configs, general: () => general,
        option: () => nativeOption, setOption: value => { nativeOption = value; },
        ignoreOptionWrites: () => { ignoreOptionWrites = true; },
        rejectOptionWrites: () => { rejectOptionWrites = true; },
        allowOptionWrites: () => { ignoreOptionWrites = false; rejectOptionWrites = false; },
        setConfigs: value => { configs = Object.assign({}, configs, value); },
        ignoreConfigs: () => { ignoreConfigs = true; },
        ignoreUmount: value => { ignoreUmount = value; },
        interruptArchive: () => { interruptArchive = true; },
        process: (pid, executable, args) => {
            write("/proc/" + pid + "/cmdline", args.join("\0") + "\0");
            links.set(location("/proc/" + pid + "/exe"), executable);
        },
        mountAll: () => {
            const lines = [];
            for (const [name, target] of Object.entries(installer.targets)) {
                write(target, fs.readFileSync(path.join(payload, "patched", name)));
                lines.push("owned-device " + target + " ext4 rw 0 0");
            }
            for (const base of ["/tmp/checkpoint", "/mnt/lg/cmn_data/checkpoint"]) {
                for (const app of ["com.webos.app.fullhome", "com.webos.app.screensaver"]) {
                    const name = base + "/" + app;
                    fs.mkdirSync(location(name), {recursive: true});
                    lines.push("b9-home-custom " + name + " tmpfs ro 0 0");
                }
            }
            write("/proc/mounts", lines.join("\n") + "\n");
        },
        dispose: () => fs.rmSync(root, {recursive: true, force: true})
    };
}

function withFixture(callback) {
    const state = fixture();
    try { callback(state); } finally { state.dispose(); }
}

check("read-only native preflight creates no installed state", () => withFixture(s => {
    assert.equal(installer.run("preflight", s.options).compatible, true);
    assert.equal(fs.existsSync(s.location(BASE)), false);
    assert.equal(s.calls.some(c => /setConfigs|setSystemSettings|\/create$/.test(c.args[c.args.length - 2] || "")), false);
}));
check("non-root installation is refused before changes", () => withFixture(s => {
    assert.throws(() => installer.run("apply", {...s.options, uid: 1000}), /Rooted Homebrew/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("firmware mismatch is refused before changes", () => withFixture(s => {
    s.write("/etc/starfish-release", "other firmware");
    assert.throws(() => installer.run("apply", s.options), /Unsupported TV firmware/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("Homebrew failsafe cannot produce a success-shaped persistent install", () => withFixture(s => {
    s.write("/var/luna/preferences/webosbrew_failsafe", "1");
    assert.throws(() => installer.run("apply", s.options), /failsafe mode/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("unknown native files are never overwritten", () => withFixture(s => {
    s.write(installer.targets["main.qml"], "another owner's patch");
    assert.throws(() => installer.run("apply", s.options), /Native firmware file differs/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("intentionally stopped UI services remain stopped", () => withFixture(s => {
    s.stop("sam");
    assert.throws(() => installer.run("apply", s.options), /leaving it stopped: sam/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
    assert.equal(s.calls.some(c => c.command === "/sbin/initctl" && c.args[0] !== "status"), false);
}));
check("another startup activity owner is preserved", () => withFixture(s => {
    s.owner("another.service");
    assert.throws(() => installer.run("apply", s.options), /Another owner controls the persistent/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("fresh installation contains runtime, media, native settings and persistence", () => withFixture(s => {
    const result = installer.run("apply", s.options);
    assert.equal(result.installed, true);
    assert.equal(result.activationScheduled, true);
    assert.equal(s.activated(), 1);
    manifest.files.forEach(entry => {
        assert.equal(crypto.createHash("sha256").update(
            fs.readFileSync(s.location(BASE + "/" + entry.path))).digest("hex"), entry.sha256);
    });
    const defaults = JSON.parse(fs.readFileSync(s.location(BASE + "/web/data/settings.json"), "utf8"));
    assert.equal(defaults.hideInputsButton, false);
    assert.equal(defaults.hideHintButton, false);
    assert.equal(s.links.get(s.location("/var/lib/webosbrew/init.d/30-b9-home-custom")), BASE + "/boot.sh");
    assert.equal(s.configs()[BOOSTER], false);
    assert.deepEqual(s.general(), manifest.general);
    assert.deepEqual(s.option(), {quickStartMode: "on"});
    assert.deepEqual(JSON.parse(fs.readFileSync(s.location(BASE + "/settings.option.restore.json"))),
        {category: "option", settings: {quickStartMode: "off"}});
    assert.ok(s.calls.some(c => c.command === "/usr/bin/luna-send" &&
        c.args[c.args.length - 2].endsWith("/setSystemSettings") &&
        JSON.parse(c.args[c.args.length - 1]).category === "option" &&
        JSON.parse(c.args[c.args.length - 1]).store === true &&
        JSON.parse(c.args[c.args.length - 1]).notify === true));
    const boot = JSON.parse(fs.readFileSync(s.location("/var/luna/preferences/bootd.json"), "utf8"));
    assert.deepEqual(boot.common.firstAppByPowerOnReason, {});
    assert.ok(s.calls.some(c => c.args.includes("luna://com.palm.activitymanager/create")));
    assert.ok(fs.existsSync(s.location(result.backup + "/native-before.json")));
    assert.ok(fs.existsSync(s.location(BASE + "/settings.config.restore.json")));
}));
check("reinstall preserves user settings, media and original rollback values", () => withFixture(s => {
    installer.run("apply", s.options);
    const config = JSON.parse(fs.readFileSync(path.join(payload, "web/data/settings.json"), "utf8"));
    config.screensaverSeconds = 180;
    config.hideInputsButton = true;
    config.hideHintButton = true;
    s.write(BASE + "/web/data/settings.json", JSON.stringify(config));
    s.write(BASE + "/web/data/background", "user's replacement image");
    s.write(BASE + "/web/data/wallpaper.mp4", "user's replacement video");
    const restore = fs.readFileSync(s.location(BASE + "/settings.restore.json"));
    const optionRestore = fs.readFileSync(s.location(BASE + "/settings.option.restore.json"));
    s.setOption({quickStartMode: "off"});
    s.write(BASE + "/activated-boot", "test-boot\n");
    const result = installer.run("apply", s.options);
    assert.equal(result.activationScheduled, false);
    assert.equal(s.activated(), 1);
    assert.equal(JSON.parse(fs.readFileSync(s.location(BASE + "/web/data/settings.json"))).screensaverSeconds, 180);
    assert.equal(JSON.parse(fs.readFileSync(s.location(BASE + "/web/data/settings.json"))).hideInputsButton, true);
    assert.equal(JSON.parse(fs.readFileSync(s.location(BASE + "/web/data/settings.json"))).hideHintButton, true);
    assert.equal(fs.readFileSync(s.location(BASE + "/web/data/background"), "utf8"), "user's replacement image");
    assert.equal(fs.readFileSync(s.location(BASE + "/web/data/wallpaper.mp4"), "utf8"), "user's replacement video");
    assert.deepEqual(fs.readFileSync(s.location(BASE + "/settings.restore.json")), restore);
    assert.deepEqual(s.option(), {quickStartMode: "on"});
    assert.deepEqual(fs.readFileSync(s.location(BASE + "/settings.option.restore.json")), optionRestore);
}));
check("Q Start+ already on is preserved as the original rollback value", () => withFixture(s => {
    s.setOption({quickStartMode: "on"});
    installer.run("apply", s.options);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.location(BASE + "/settings.option.restore.json"))),
        {category: "option", settings: {quickStartMode: "on"}});
}));
check("unsupported Q Start+ is refused before any installation changes", () => withFixture(s => {
    s.setOption({});
    assert.throws(() => installer.run("apply", s.options), /Unsupported Q Start/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("a package without the required Q Start+ policy is refused", () => withFixture(s => {
    assert.throws(() => installer.run("apply", {
        ...s.options, manifest: {...manifest, option: {quickStartMode: "off"}}
    }), /Invalid Home package manifest/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
}));
check("invalid original Q Start+ backup is rejected without overwriting it", () => withFixture(s => {
    installer.run("apply", s.options);
    const bad = JSON.stringify({category: "general", settings: {quickStartMode: "off"}});
    s.write(BASE + "/settings.option.restore.json", bad);
    assert.throws(() => installer.run("preflight", s.options), /Invalid Q Start\+ settings backup/);
    assert.equal(fs.readFileSync(s.location(BASE + "/settings.option.restore.json"), "utf8"), bad);
}));
check("rejected Q Start+ writes cannot report successful installation", () => withFixture(s => {
    s.rejectOptionWrites();
    assert.throws(() => installer.run("apply", s.options), /Q Start\+ write rejected/);
    assert.equal(fs.existsSync(s.location(BASE + "/package-installed.json")), false);
    assert.equal(s.activated(), 0);
}));
check("acknowledged but ineffective Q Start+ writes fail readback verification", () => withFixture(s => {
    s.ignoreOptionWrites();
    assert.throws(() => installer.run("apply", s.options), /Q Start\+ preference did not persist/);
    assert.equal(fs.existsSync(s.location(BASE + "/package-installed.json")), false);
    assert.equal(s.activated(), 0);
}));
check("native failures cannot report successful installation", () => withFixture(s => {
    s.reject("luna://com.webos.settingsservice/setSystemSettings");
    assert.throws(() => installer.run("apply", s.options), /Installation did not finish.*Preserved backup/s);
    assert.equal(s.activated(), 0);
    assert.equal(fs.existsSync(s.location(BASE + "/package-installed.json")), false);
}));

const RESTORE = "/var/lib/webosbrew/b9-home-custom.restore.json";
check("status checks are read-only and never reapply an installed configuration", () => withFixture(s => {
    assert.equal(installer.run("status", s.options).state, "not-installed");
    assert.equal(fs.existsSync(s.location(BASE)), false);
    installer.run("apply", s.options);
    s.calls.length = 0;
    assert.equal(installer.run("status", s.options).state, "installed");
    assert.equal(s.activated(), 1);
    assert.equal(s.calls.some(c => /setConfigs|setSystemSettings|\/create$/.test(c.args[c.args.length - 2] || "")), false);
}));
check("stock restore removes all overlays and persistence while retaining user data and backups", () => withFixture(s => {
    const general = {...s.general()};
    installer.run("apply", s.options);
    s.mountAll();
    s.write(BASE + "/web/data/custom-wallpaper.mp4", "owner media");
    s.write(BASE + "/web/server.pid", "801");
    s.process("801", "/usr/bin/node", ["/usr/bin/node", BASE + "/web/server.js"]);
    s.process("802", "/usr/bin/com.webos.app.fullhome", ["/usr/bin/com.webos.app.fullhome"]);
    s.write(BASE + "/idle-policy.restore.json", '{"previous":60000}');
    s.write(BASE + "/picture-context.restore.json", '{"input":"HDMI_2","card":"com.webos.app.hdmi2"}');
    s.setConfigs({"com.webos.surfacemanager.userActivityTimeout": 2147483647});
    s.calls.length = 0;
    const result = installer.run("restore", s.options);
    assert.equal(result.restored, true);
    assert.equal(result.restartRequired, true);
    assert.equal(fs.existsSync(s.location(BASE)), false);
    assert.equal(s.links.has(s.location("/var/lib/webosbrew/init.d/30-b9-home-custom")), false);
    assert.equal(fs.readFileSync(s.location(result.archive + "/web/data/custom-wallpaper.mp4"), "utf8"), "owner media");
    assert.deepEqual(s.general(), general);
    assert.deepEqual(s.option(), {quickStartMode: "off"});
    assert.equal(s.configs()[BOOSTER], true);
    assert.equal(s.configs()["com.webos.surfacemanager.userActivityTimeout"], 60000);
    assert.equal(s.links.has(s.location("/proc/801/exe")), false);
    assert.equal(s.links.has(s.location("/proc/802/exe")), false);
    assert.equal(fs.existsSync(s.location("/var/luna/preferences/bootd.json")), false);
    assert.equal(fs.readFileSync(s.location("/proc/mounts"), "utf8").trim(), "");
    assert.equal(s.calls.some(c => c.command === "/sbin/initctl"), false);
    assert.equal(installer.run("status", s.options).state, "restored");
    assert.equal(installer.run("restore", s.options).archive, result.archive);
}));
check("restore preserves originally enabled Q Start+ and an originally disabled booster", () => withFixture(s => {
    s.setOption({quickStartMode: "on"});
    s.setConfigs({[BOOSTER]: false});
    installer.run("apply", s.options);
    installer.run("restore", s.options);
    assert.deepEqual(s.option(), {quickStartMode: "on"});
    assert.equal(s.configs()[BOOSTER], false);
}));
check("restore restores an original boot override without removing it", () => withFixture(s => {
    const original = fs.readFileSync(s.location("/etc/palm/bootd.json"), "utf8");
    s.write("/var/luna/preferences/bootd.json", original);
    installer.run("apply", s.options);
    installer.run("restore", s.options);
    assert.equal(fs.readFileSync(s.location("/var/luna/preferences/bootd.json"), "utf8"), original);
}));
check("failed unmounts cannot report success and a retry completes restoration", () => withFixture(s => {
    installer.run("apply", s.options);
    s.mountAll();
    s.ignoreUmount(true);
    assert.throws(() => installer.run("restore", s.options), /Stock native file not restored/);
    assert.equal(installer.run("status", s.options).state, "restore-needed");
    assert.equal(JSON.parse(fs.readFileSync(s.location(RESTORE))).phase, "restoring");
    s.ignoreUmount(false);
    assert.equal(installer.run("restore", s.options).restored, true);
}));
check("rejected and ineffective native restore writes never produce successful restoration", () => {
    for (const failure of ["rejectOptionWrites", "ignoreOptionWrites", "ignoreConfigs"]) withFixture(s => {
        installer.run("apply", s.options);
        s[failure]();
        assert.throws(() => installer.run("restore", s.options), /Stock restoration did not finish/);
        assert.equal(JSON.parse(fs.readFileSync(s.location(RESTORE))).phase, "restoring");
        assert.equal(fs.existsSync(s.location(BASE)), true);
    });
});
check("restoration resumes after interruption following the archive move", () => withFixture(s => {
    installer.run("apply", s.options);
    s.interruptArchive();
    assert.throws(() => installer.run("restore", s.options), /Simulated interruption/);
    assert.equal(fs.existsSync(s.location(BASE)), false);
    assert.equal(installer.run("status", s.options).state, "restore-needed");
    assert.equal(installer.run("restore", s.options).restored, true);
}));
check("foreign snapshots, boot policy, processes and invalid journals are refused before changes", () => {
    for (const fault of ["snapshot", "boot", "server", "journal", "controller"]) withFixture(s => {
        installer.run("apply", s.options);
        if (fault === "snapshot") s.write("/proc/mounts", "other /tmp/checkpoint/com.webos.app.fullhome tmpfs rw 0 0\n");
        if (fault === "boot") s.write("/var/luna/preferences/bootd.json", '{"otherOwner":true}');
        if (fault === "server") {
            s.write(BASE + "/web/server.pid", "901");
            s.process("901", "/usr/bin/node", ["/usr/bin/node", "/unrelated/server.js"]);
        }
        if (fault === "journal") s.write(BASE + "/settings.option.restore.json", '{"category":"option","settings":{"quickStartMode":"invalid"}}');
        if (fault === "controller") s.write(BASE + "/control.sh", "changed controller");
        assert.throws(() => installer.run("restore", s.options));
        assert.equal(s.links.has(s.location("/var/lib/webosbrew/init.d/30-b9-home-custom")), true);
        assert.equal(fs.existsSync(s.location(RESTORE)), false);
    });
});
check("restore works in failsafe mode without starting intentionally stopped UI services", () => withFixture(s => {
    installer.run("apply", s.options);
    s.write("/var/luna/preferences/webosbrew_failsafe", "1");
    s.stop("sam");
    s.calls.length = 0;
    assert.equal(installer.run("restore", s.options).restored, true);
    assert.equal(s.calls.some(c => c.command === "/sbin/initctl"), false);
}));
check("an explicit reinstall after restoration clears restored status without losing the archive", () => withFixture(s => {
    installer.run("apply", s.options);
    const restored = installer.run("restore", s.options);
    installer.run("apply", s.options);
    assert.equal(installer.run("status", s.options).state, "installed");
    assert.equal(fs.existsSync(s.location(restored.archive)), true);
    assert.equal(installer.run("restore", s.options).restored, true);
}));
check("firmware-free installation and restoration use only locally generated overlays", () => withFixture(s => {
    const packed = path.join(s.root, "firmware-free-payload");
    fs.cpSync(payload, packed, {recursive: true});
    const recipe = {format: 1, files: []};
    for (const name of Object.keys(installer.targets)) {
        const original = fs.readFileSync(path.join(payload, "original", name));
        const patched = fs.readFileSync(path.join(payload, "patched", name));
        const hash = value => crypto.createHash("sha256").update(value).digest("hex");
        recipe.files.push({
            name, originalSize: original.length, originalSha256: hash(original),
            patchedSize: patched.length, patchedSha256: hash(patched),
            edits: [{at: 0, remove: original.length, pieces: [{text: patched.toString("utf8")}]}]
        });
        fs.unlinkSync(path.join(packed, "original", name));
        fs.unlinkSync(path.join(packed, "patched", name));
    }
    const recipeBytes = Buffer.from(JSON.stringify(recipe));
    const packedManifest = {...manifest, firmwareRecipeSha256: crypto.createHash("sha256").update(recipeBytes).digest("hex")};
    fs.writeFileSync(path.join(packed, "manifest.json"), JSON.stringify(packedManifest));
    fs.writeFileSync(path.join(packed, "firmware-patches.json"), recipeBytes);
    const options = {...s.options, payloadDirectory: packed};
    assert.equal(installer.run("status", options).state, "not-installed");
    assert.equal(options.payloadDirectory, packed, "Preparation does not mutate caller options");
    assert.equal(installer.run("apply", options).installed, true);
    assert.equal(installer.run("restore", options).restored, true);
    assert.equal(installer.run("status", options).state, "restored");
    assert.equal(fs.existsSync(path.join(packed, "original/main.qml")), false);
}));
check("TV setup app handles status, automatic setup, pointer-only restore and safe retries", require("./setup.test"));
console.log(checks + " package checks passed");
