"use strict";

var fs = require("fs");
var path = require("path");
var atomicWrite = require("./storage");
var native = require("./native-home");
var KEY = "com.webos.surfacemanager.userActivityTimeout";
var HOLD = 2147483647;

function create(options) {
    var journalPath = path.join(options.base, "idle-policy.restore.json");
    var journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : null;
    if (journal && (!valid(journal.previous) || held(journal.previous))) {
        throw new Error("Invalid Home idle-policy restoration record.");
    }
    var busy = false;
    var closing = false;
    var closed = false;
    var active = false;
    var card = "";
    var timer;
    var errorMessage = "";
    var callbacks = [];
    var heldAt = Date.now();

    function valid(value) {
        return typeof value === "number" && value > 0 && value <= HOLD && value % 1 === 0;
    }

    function held(value) { return value === HOLD || value === HOLD - 1; }

    function writeJournal(value) {
        atomicWrite(journalPath, JSON.stringify(value) + "\n");
        journal = value;
    }

    function read(callback) {
        native.request("com.webos.service.config/getConfigs", {configNames: [KEY]}, function (error, result) {
            if (error) { callback(error); return; }
            var value = result.configs && result.configs[KEY];
            callback(valid(value) ? null : new Error("Native Home idle timeout is unavailable."), value);
        });
    }

    function select(value, callback) {
        var configs = {};
        configs[KEY] = value;
        native.request("com.webos.service.config/setConfigs", {configs: configs}, function (error) {
            if (error) { callback(error); return; }
            read(function (readError, current) {
                callback(readError || (current === value ? null : new Error("Home idle timeout changed during selection.")));
            });
        });
    }

    function finish(error) {
        busy = false;
        if (error) {
            if (errorMessage !== error.message) console.error("Home idle: " + error.message);
            errorMessage = error.message;
        } else errorMessage = "";
        if (closing) {
            if (journal && !error) { check(); return; }
            closed = true;
            var waiting = callbacks;
            callbacks = [];
            waiting.forEach(function (callback) { callback(error); });
        } else timer = setTimeout(check, 1000);
    }

    function clear(error) {
        if (!error) {
            try { writeJournal(null); }
            catch (writeError) { finish(writeError); return; }
            active = false;
            card = "";
        }
        finish(error);
    }

    function restore(originalError) {
        active = false;
        card = "";
        if (!journal) { finish(originalError); return; }
        read(function (error, current) {
            if (error) { finish(error); return; }
            if (!held(current)) { clear(originalError); return; }
            select(journal.previous, function (restoreError) {
                if (restoreError) { finish(restoreError); return; }
                try { writeJournal(null); }
                catch (writeError) { finish(writeError); return; }
                console.log("Home idle: restored native UI timeout.");
                finish(originalError);
            });
        });
    }

    function check() {
        if (busy || closed) return;
        busy = true;
        if (closing || !options.enabled()) { restore(); return; }
        native.foreground(function (error, windows) {
            if (error) { restore(error); return; }
            if (!native.visible(windows)) { restore(); return; }
            read(function (readError, current) {
                if (readError) { restore(readError); return; }
                if (journal && !held(current)) {
                    // Another owner changed the timeout; release our stale record before acquiring again.
                    clear();
                    return;
                }
                if (held(current)) {
                    active = true;
                    card = native.cardOf(windows);
                    if (journal && Date.now() - heldAt >= 6 * 60 * 60 * 1000) {
                        select(current === HOLD ? HOLD - 1 : HOLD, function (renewError) {
                            if (renewError) { restore(renewError); return; }
                            heldAt = Date.now();
                            finish();
                        });
                        return;
                    }
                    finish();
                    return;
                }
                try { writeJournal({previous: current}); }
                catch (writeError) { finish(writeError); return; }
                native.foreground(function (recheckError, currentWindows) {
                    if (recheckError) { restore(recheckError); return; }
                    if (closing || !options.enabled() || !native.visible(currentWindows) ||
                            native.cardOf(currentWindows) !== native.cardOf(windows)) {
                        restore();
                        return;
                    }
                    select(HOLD, function (selectError) {
                        if (selectError) { restore(selectError); return; }
                        active = true;
                        card = native.cardOf(windows);
                        heldAt = Date.now();
                        console.log("Home idle: holding UI timeout while custom Home is visible.");
                        if (closing) { restore(); return; }
                        finish();
                    });
                });
            });
        });
    }

    function close(callback) {
        callback = callback || function (error) {
            if (error) console.error("Home idle shutdown: " + error.message);
        };
        if (closed) { callback(errorMessage ? new Error(errorMessage) : null); return; }
        callbacks.push(callback);
        closing = true;
        clearTimeout(timer);
        if (!busy) check();
    }

    check();
    return {
        close: close,
        state: function () { return {active: active, card: card, error: errorMessage}; }
    };
}

module.exports = {create: create};
