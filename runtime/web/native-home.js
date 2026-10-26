"use strict";

var childProcess = require("child_process");
var CARD = "_WEBOS_WINDOW_TYPE_CARD";
var HOME = "_WEBOS_WINDOW_TYPE_HOME";

function request(method, payload, callback) {
    childProcess.execFile("/usr/bin/luna-send",
        ["-n", "1", "-w", "1500", "luna://" + method, JSON.stringify(payload)],
        {timeout: 2000, maxBuffer: 65536}, function (error, stdout) {
            if (error) { callback(error); return; }
            var value;
            try {
                value = JSON.parse(stdout);
                if (value.returnValue !== true) throw new Error(value.errorText || "Native Home request rejected.");
            } catch (parseError) { callback(parseError); return; }
            callback(null, value);
        });
}

function foreground(callback) {
    request("com.webos.surfacemanager/getForegroundAppInfo", {}, function (error, result) {
        if (error) { callback(error); return; }
        var windows = result.foregroundAppInfo;
        if (!Array.isArray(windows) || windows.some(function (window) {
            return !window || typeof window.appId !== "string" || typeof window.windowType !== "string";
        }) || windows.filter(function (window) { return window.windowType === CARD; }).length > 1) {
            callback(new Error("Invalid foreground windows for Home policy."));
            return;
        }
        callback(null, windows);
    });
}

function cardOf(windows) {
    var cards = windows.filter(function (window) { return window.windowType === CARD; });
    return cards.length ? cards[0].appId : "";
}

function visible(windows) {
    return windows.some(function (window) {
        return window.appId === "com.webos.app.fullhome" && window.windowType === HOME;
    }) && !windows.some(function (window) {
        return window.windowType !== CARD && window.windowType !== HOME;
    });
}

module.exports = {request: request, foreground: foreground, cardOf: cardOf, visible: visible};
