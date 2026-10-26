"use strict";

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

function create(options) {
    var base = options.base;
    var bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    var stopped = false;
    var subscription;
    var reconnectTimer;
    var checkTimer;
    var generation = 0;
    var pending = false;
    var active = null;
    var wakeTime = 0;
    var reconnectDelay = 1000;
    var errorMessage = "";
    var lastLaunch = null;
    var checking = null;
    var errorSource = "";
    var saverCard = null;
    var sleeping = false;

    function report(error, source) {
        errorMessage = error.message;
        errorSource = source || "handoff";
        console.error("Home wake: " + errorMessage);
    }

    function rpc(uri, payload, callback) {
        childProcess.execFile("/usr/bin/luna-send",
            ["-n", "1", "-w", "2000", uri, JSON.stringify(payload)],
            {timeout: 3000, maxBuffer: 65536}, function (error, stdout) {
                if (error) { callback(error); return; }
                var value;
                try {
                    value = JSON.parse(stdout);
                    if (value.returnValue !== true) throw new Error(value.errorText || "Native request rejected.");
                } catch (parseError) { callback(parseError); return; }
                callback(null, value);
            });
    }

    function schedule(token) {
        clearTimeout(checkTimer);
        if (stopped || !pending || !active || token !== generation || checking === token) return;
        if (Date.now() - wakeTime > 20000) {
            pending = false;
            report(new Error("Native wake did not finish within 20 seconds; Home was not forced over another screen."));
            return;
        }
        checkTimer = setTimeout(function () { check(token); }, 500);
    }

    function retry(token) {
        if (checking === token) checking = null;
        schedule(token);
    }

    function check(token) {
        if (stopped || !pending || !active || token !== generation || checking === token) return;
        checking = token;
        var readyPath = path.join(base, "activated-boot");
        try {
            if (!fs.existsSync(readyPath) || fs.readFileSync(readyPath, "utf8").trim() !== bootId) {
                retry(token);
                return;
            }
        } catch (error) { report(error); retry(token); return; }
        rpc("luna://com.webos.bootManager/getBootStatus", {}, function (error, boot) {
            if (stopped || !pending || !active || token !== generation) return;
            if (error) { report(error); retry(token); return; }
            if (!boot.firstAppLaunched) { retry(token); return; }
            rpc("luna://com.webos.surfacemanager/getForegroundAppInfo", {}, function (foregroundError, result) {
                if (stopped || !pending || !active || token !== generation) return;
                if (foregroundError) { report(foregroundError); retry(token); return; }
                var windows = result.foregroundAppInfo;
                if (!Array.isArray(windows)) {
                    report(new Error("Native wake returned an invalid foreground-window list."));
                    retry(token);
                    return;
                }
                var covered = windows.some(function (window) {
                    return window.windowType !== "_WEBOS_WINDOW_TYPE_CARD" &&
                        window.windowType !== "_WEBOS_WINDOW_TYPE_HOME";
                });
                if (covered) { retry(token); return; }
                var otherApp = windows.some(function (window) {
                    return window.windowType === "_WEBOS_WINDOW_TYPE_CARD" &&
                        !/^com\.webos\.app\.(hdmi[1-4]|inputcommon|livetv|discovery|fullhome|externalinput\..+)$/.test(window.appId);
                });
                if (otherApp) {
                    pending = false;
                    checking = null;
                    console.log("Home wake: foreground app changed; keeping the selected app.");
                    return;
                }
                if (saverCard !== null && !windows.some(function (window) {
                    return window.windowType === "_WEBOS_WINDOW_TYPE_CARD" && window.appId === saverCard;
                })) {
                    pending = false;
                    checking = null;
                    saverCard = null;
                    return;
                }
                if (windows.some(function (window) {
                    return window.appId === "com.webos.app.fullhome" &&
                        window.windowType === "_WEBOS_WINDOW_TYPE_HOME";
                })) {
                    pending = false;
                    checking = null;
                    saverCard = null;
                    return;
                }
                rpc("luna://com.webos.applicationManager/launch",
                    {id: "com.webos.app.fullhome", params: {launchType: "homeKey"}},
                    function (launchError) {
                        if (stopped || !active || token !== generation) return;
                        if (launchError) { report(launchError); retry(token); return; }
                        pending = false;
                        checking = null;
                        errorMessage = "";
                        errorSource = "";
                        lastLaunch = Date.now();
                        saverCard = null;
                        console.log("Home wake: custom Home activated after native wake handoff.");
                    });
            });
        });
    }

    function update(value) {
        if (value.returnValue !== true || typeof value.state !== "string") {
            report(new Error(value.errorText || "Invalid TV power subscription response."));
            return;
        }
        reconnectDelay = 1000;
        if (errorSource === "power") {
            errorMessage = "";
            errorSource = "";
        }
        var preparing = /^(Request|Prepare) (Power Off|Active Standby|Suspend)$/.test(value.processing || "");
        active = value.state === "Active" && !preparing;
        if (value.state === "Active Standby" || value.state === "Suspend" || preparing) {
            saverCard = null;
            if (!sleeping) generation++;
            sleeping = true;
            pending = true;
            wakeTime = 0;
            clearTimeout(checkTimer);
        } else if (value.state === "Screen Saver" && options.homeCard && !pending) {
            saverCard = options.homeCard();
            if (saverCard !== null) {
                generation++;
                pending = true;
                wakeTime = 0;
            }
            clearTimeout(checkTimer);
        } else if (active && pending && !value.processing) {
            sleeping = false;
            if (!wakeTime) wakeTime = Date.now();
            schedule(generation);
        } else if (!active) clearTimeout(checkTimer);
        else if (active) sleeping = false;
    }

    function connect() {
        if (stopped) return;
        var buffer = "";
        var failed = false;
        var child = childProcess.spawn("/usr/bin/luna-send",
            ["-i", "luna://com.webos.service.tvpower/power/getPowerState", '{"subscribe":true}'],
            {stdio: ["ignore", "pipe", "pipe"]});
        subscription = child;
        function fail(error) {
            if (stopped || failed) return;
            failed = true;
            active = null;
            clearTimeout(checkTimer);
            report(error, "power");
            child.kill("SIGTERM");
        }
        child.stdout.on("data", function (chunk) {
            if (stopped || failed) return;
            buffer += chunk.toString("utf8");
            if (buffer.length > 65536) { fail(new Error("TV power subscription exceeded its response limit.")); return; }
            var start = -1;
            var depth = 0;
            var quoted = false;
            var escaped = false;
            for (var index = 0; index < buffer.length; index++) {
                var character = buffer.charAt(index);
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (character === "\\") escaped = true;
                    else if (character === '"') quoted = false;
                } else if (character === '"') quoted = true;
                else if (character === "{") {
                    if (!depth) start = index;
                    depth++;
                } else if (character === "}") {
                    depth--;
                    if (depth < 0) { fail(new Error("Invalid TV power subscription JSON.")); return; }
                    if (!depth && start !== -1) {
                        var value;
                        try { value = JSON.parse(buffer.slice(start, index + 1)); }
                        catch (parseError) { fail(parseError); return; }
                        update(value);
                        buffer = buffer.slice(index + 1);
                        index = -1;
                        start = -1;
                    }
                }
            }
        });
        child.stderr.on("data", function (chunk) {
            fail(new Error("TV power subscription: " + chunk.toString("utf8").trim()));
        });
        child.on("error", fail);
        child.on("close", function (code) {
            if (stopped) return;
            if (!failed) report(new Error("TV power subscription exited with code " + code + "."), "power");
            active = null;
            if (pending) generation++;
            checking = null;
            clearTimeout(checkTimer);
            reconnectTimer = setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        });
    }

    function close() {
        if (stopped) return;
        stopped = true;
        clearTimeout(checkTimer);
        clearTimeout(reconnectTimer);
        if (subscription) subscription.kill("SIGTERM");
        process.removeListener("SIGTERM", close);
    }

    process.on("SIGTERM", close);
    connect();
    return {
        close: close,
        state: function () {
            return {active: active, generation: generation, pending: pending,
                lastLaunch: lastLaunch, error: errorMessage};
        }
    };
}

module.exports = {create: create};
