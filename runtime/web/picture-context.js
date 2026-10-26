"use strict";

var fs = require("fs");
var path = require("path");
var atomicWrite = require("./storage");
var native = require("./native-home");
var HOME_INPUT = "default";
var rpc = native.request;
var foreground = native.foreground;
var cardOf = native.cardOf;
var visible = native.visible;

function create(options) {
    var journalPath = path.join(options.base, "picture-context.restore.json");
    var journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : null;
    if (journal && (typeof journal.input !== "string" || journal.input === HOME_INPUT ||
            typeof journal.card !== "string")) throw new Error("Invalid Home picture-context restoration record.");
    var timer;
    var busy = false;
    var closing = false;
    var closed = false;
    var active = false;
    var errorMessage = "";
    var closeCallbacks = [];
    var refreshCallbacks = [];
    var refreshError = "";
    var refreshes = 0;

    function writeJournal(value) {
        atomicWrite(journalPath, JSON.stringify(value) + "\n");
        journal = value;
    }

    function getInput(callback) {
        rpc("com.webos.settingsservice/getSystemSettings",
            {category: "dimensionInfo", keys: ["input"]}, function (error, result) {
                if (error) { callback(error); return; }
                if (!result.settings || typeof result.settings.input !== "string" || !result.settings.input) {
                    callback(new Error("Native picture input is unavailable."));
                    return;
                }
                callback(null, result.settings.input);
            });
    }

    function select(input, callback) {
        rpc("com.webos.settingsservice/setSystemSettings",
            {category: "dimensionInfo", settings: {input: input}}, function (error) {
                if (error) { callback(error); return; }
                getInput(function (readError, selected) {
                    if (readError) { callback(readError); return; }
                    callback(selected === input ? null : new Error("Native picture context changed during selection."));
                });
            });
    }

    function finish(error) {
        busy = false;
        if (error) {
            if (errorMessage !== error.message) console.error("Home picture: " + error.message);
            errorMessage = error.message;
        } else errorMessage = "";
        if (refreshCallbacks.length && !closing && !error && active) {
            busy = true;
            refreshProfile();
            return;
        }
        if (refreshCallbacks.length) {
            completeRefresh(error || new Error("Home video is no longer visible."));
        }
        if (closing) {
            if (journal && !error) { check(); return; }
            closed = true;
            var callbacks = closeCallbacks;
            closeCallbacks = [];
            callbacks.forEach(function (callback) { callback(error); });
        } else timer = setTimeout(check, 1000);
    }

    function completeRefresh(error) {
        var waiting = refreshCallbacks;
        refreshCallbacks = [];
        refreshError = error ? error.message : "";
        waiting.forEach(function (callback) { callback(error); });
    }

    function refreshProfile() {
        rpc("com.webos.settingsservice/getSystemSettings",
            {category: "picture", keys: ["pictureMode", "brightness", "contrast", "backlight", "gamma"]},
            function (error, profile) {
                if (error) { completeRefresh(error); finish(error); return; }
                var dimension = profile.dimension;
                var settings = profile.settings;
                if (!dimension || dimension.input !== HOME_INPUT ||
                        typeof dimension.pictureMode !== "string" || typeof dimension._3dStatus !== "string" ||
                        !settings || typeof settings.brightness !== "number" ||
                        typeof settings.contrast !== "number" || typeof settings.backlight !== "number" ||
                        typeof settings.gamma !== "string") {
                    var invalid = new Error("Home picture profile is not ready for the video pipeline.");
                    completeRefresh(invalid);
                    finish(invalid);
                    return;
                }
                foreground(function (foregroundError, windows) {
                    if (foregroundError || closing || !options.enabled() || !visible(windows) ||
                            (journal && cardOf(windows) !== journal.card)) {
                        var hidden = foregroundError || new Error("Home video changed before its picture refresh.");
                        completeRefresh(hidden);
                        finish(closing ? null : hidden);
                        return;
                    }
                    getInput(function (inputError, input) {
                        if (inputError || input !== HOME_INPUT || closing) {
                            var changed = inputError || new Error("Home picture input changed before refresh.");
                            completeRefresh(changed);
                            finish(closing ? null : changed);
                            return;
                        }
                        rpc("com.webos.settingsservice/setSystemSettings", {
                            category: "picture",
                            dimension: {input: HOME_INPUT, pictureMode: dimension.pictureMode,
                                _3dStatus: dimension._3dStatus},
                            settings: {brightness: settings.brightness, contrast: settings.contrast,
                                backlight: settings.backlight, gamma: settings.gamma},
                            store: false,
                            notify: true
                        }, function (applyError) {
                            if (!applyError) {
                                refreshes++;
                                console.log("Home picture: reapplied existing Home profile after video startup.");
                            }
                            completeRefresh(applyError);
                            finish(applyError);
                        });
                    });
                });
            });
    }

    function refresh(callback) {
        if (closing || closed) { callback(new Error("Home picture manager is stopping.")); return; }
        refreshCallbacks.push(callback);
        clearTimeout(timer);
        if (!busy) check();
    }

    function clearJournal() {
        try { writeJournal(null); }
        catch (error) { finish(error); return false; }
        active = false;
        return true;
    }

    function restore(windows, input) {
        // A newly selected card owns its context; never restore an old HDMI profile over it.
        if (input !== HOME_INPUT || cardOf(windows) !== journal.card) {
            if (!clearJournal()) return;
            finish();
            return;
        }
        var previous = journal.input;
        foreground(function (error, currentWindows) {
            if (error) { finish(error); return; }
            if (cardOf(currentWindows) !== journal.card) {
                if (!clearJournal()) return;
                finish();
                return;
            }
            select(previous, function (restoreError) {
                if (!restoreError) {
                    if (!clearJournal()) return;
                    console.log("Home picture: restored input context " + previous + ".");
                }
                finish(restoreError);
            });
        });
    }

    function check() {
        if (busy || closed) return;
        busy = true;
        if (!journal && (closing || !options.enabled())) {
            active = false;
            finish();
            return;
        }
        foreground(function (error, windows) {
            if (error) { finish(error); return; }
            var wanted = !closing && options.enabled() && visible(windows);
            if (!wanted && !journal) { active = false; finish(); return; }
            getInput(function (inputError, input) {
                if (inputError) { finish(inputError); return; }
                try {
                    var card = cardOf(windows);
                    if (journal && (!wanted || input !== HOME_INPUT || card !== journal.card)) {
                        restore(windows, input);
                        return;
                    }
                    if (!wanted) { active = false; finish(); return; }
                    if (input === HOME_INPUT) { active = true; finish(); return; }
                    writeJournal({input: input, card: card});
                    foreground(function (recheckError, currentWindows) {
                        if (recheckError) { finish(recheckError); return; }
                        if (closing || !options.enabled() || !visible(currentWindows) || cardOf(currentWindows) !== card) {
                            if (!clearJournal()) return;
                            finish();
                            return;
                        }
                        select(HOME_INPUT, function (selectError) {
                            active = !selectError;
                            if (!selectError) console.log("Home picture: selected independent non-HDMI context.");
                            finish(selectError);
                        });
                    });
                } catch (stateError) { finish(stateError); }
            });
        });
    }

    function close(callback) {
        callback = callback || function (error) {
            if (error) console.error("Home picture shutdown: " + error.message);
        };
        if (closed) { callback(errorMessage ? new Error(errorMessage) : null); return; }
        closeCallbacks.push(callback);
        closing = true;
        clearTimeout(timer);
        if (!busy) check();
    }

    check();
    return {
        close: close,
        refresh: refresh,
        state: function () {
            return {active: active, input: HOME_INPUT, refreshes: refreshes, error: refreshError || errorMessage};
        }
    };
}

module.exports = {create: create};
