"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const app = path.join(__dirname, "app");
const html = fs.readFileSync(path.join(app, "index.html"), "utf8");
const script = fs.readFileSync(path.join(app, "setup.js"), "utf8");

function fixture(options = {}) {
    const nodes = {};
    let focused;
    for (const match of html.matchAll(/id="([^"]+)"/g)) {
        nodes[match[1]] = {
            textContent: "", style: {}, attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; },
            getAttribute(name) { return this.attributes[name]; },
            focus() { focused = match[1]; }
        };
    }
    const body = {attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }};
    const github = html.match(/<a id="github"[^>]*href="([^"]+)"[^>]*>/);
    assert.ok(github, "Setup and restore screen includes a GitHub link");
    assert.equal(github[1], "https://github.com/pecrow/LG-webOS-Glass-Home");
    nodes.github.attributes.href = github[1];
    const requests = [];
    const browserRequests = [];
    const timers = [];
    const errors = [];
    function Bridge() {
        if (options.constructorError) throw new Error(options.constructorError);
        this.canceled = 0;
        this.cancel = () => {
            this.canceled++;
            if (options.cancelError) throw new Error(options.cancelError);
        };
        this.call = (uri, value) => {
            if (uri === "luna://com.webos.applicationManager/launch") {
                browserRequests.push(this);
                assert.deepEqual(JSON.parse(value), {
                    id: "com.webos.app.browser", params: {target: github[1]}
                });
                if (options.browserCallError) throw new Error(options.browserCallError);
                return;
            }
            requests.push(this);
            assert.equal(uri, "luna://org.webosbrew.hbchannel.service/exec");
            assert.match(JSON.parse(value).command,
                /^flock -x \/var\/lock\/b9-home-package\.lock \/usr\/bin\/node \/media\/developer\/apps\/usr\/palm\/applications\/org\.webosbrew\.b9homecustom\/installer\.js (status|apply|restore)$/);
            this.action = JSON.parse(value).command.split(" ").pop();
            if (options.callError) throw new Error(options.callError);
        };
    }
    const window = options.missingBridge ? {} :
        options.palmBridge ? {PalmServiceBridge: Bridge} : {webOSServiceBridge: Bridge};
    vm.runInNewContext(script, {
        window,
        document: {
            body,
            getElementById(id) {
                assert.ok(nodes[id], "Setup script references a real HTML element: " + id);
                return nodes[id];
            }
        },
        console: {error: message => errors.push(message)},
        setTimeout(callback, delay) {
            assert.ok(delay === 10000 || delay === 60000 || delay === 180000);
            const timer = {callback, cleared: false};
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) { if (timer) timer.cleared = true; }
    });
    return {nodes, requests, browserRequests, timers, errors, window, Bridge,
        state: () => body.attributes["data-state"], focused: () => focused};
}

function success(activationScheduled = true, overrides = {}) {
    return JSON.stringify({
        returnValue: true,
        stdoutString: "Installer output\n" + JSON.stringify(Object.assign({
            returnValue: true, installed: true, activationScheduled, backup: "/backup"
        }, overrides))
    });
}

function assertFailed(s, message) {
    assert.equal(s.state(), "error");
    assert.equal(s.nodes["progress-panel"].attributes["aria-busy"], "false");
    assert.match(s.nodes.description.textContent, /did not finish/);
    assert.match(s.nodes.details.textContent, message);
    assert.equal(s.nodes.details.style.display, "block");
    assert.equal(s.nodes.retry.style.display, "inline-block");
    assert.equal(s.focused(), "retry");
    assert.equal(s.nodes["quick-start-label"].textContent, "Q Start+ standby");
    assert.equal(s.nodes["quick-start-description"].textContent, "No new setting confirmed");
    assert.ok(s.errors.length);
    assert.ok(s.timers.every(timer => timer.cleared));
}

module.exports = function () {
    let s = fixture();
    let prevented = 0;
    const linkClick = {preventDefault() { prevented++; }};
    assert.equal(s.nodes.github.attributes["aria-disabled"], "true");
    s.nodes.github.onclick(linkClick);
    assert.equal(prevented, 1);
    assert.equal(s.browserRequests.length, 0, "GitHub cannot interrupt setup");
    const archive = "/var/lib/webosbrew/b9-home-custom-restored-1792995940393-123";
    const envelope = result => JSON.stringify({returnValue: true, stdoutString: JSON.stringify(result)});
    const installed = () => envelope({returnValue: true, state: "installed", quickStartMode: "on"});
    const restoreResult = () => envelope({returnValue: true, restored: true, restartRequired: true, archive});
    const ready = options => {
        const state = fixture(options);
        state.requests[0].onservicecallback(installed());
        return state;
    };
    const pointer = state => {
        state.nodes.restore.onmouseenter({isTrusted: true});
        state.nodes.restore.onmousedown({isTrusted: true, button: 0});
        state.nodes.restore.onclick({isTrusted: true, detail: 1, button: 0});
    };
    assert.equal(s.state(), "checking");
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].action, "status");
    assert.equal(s.nodes["progress-panel"].attributes["aria-busy"], "true");
    assert.equal(s.nodes["status-badge"].textContent, "CHECKING");
    assert.equal(s.nodes.restore.disabled, true);
    assert.equal(s.nodes.details.style.display, "none");
    assert.equal(s.nodes.retry.style.display, "none");
    assert.equal(s.nodes["quick-start-label"].textContent, "Q Start+ standby");
    s.nodes.retry.onclick();
    assert.equal(s.requests.length, 1, "Repeated clicks cannot start concurrent requests");
    s.requests[0].onservicecallback(envelope({returnValue: true, state: "not-installed"}));
    assert.equal(s.state(), "working");
    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[1].action, "apply");
    s.requests[1].onservicecallback(success());
    assert.equal(s.state(), "starting");
    assert.equal(s.nodes["progress-panel"].attributes["aria-busy"], "false");
    assert.match(s.nodes.status.textContent, /Configuration installed.*Home is starting/);
    assert.match(s.nodes.details.textContent, /Backup: \/backup/);
    assert.equal(s.nodes["quick-start-label"].textContent, "Q Start+ enabled");
    assert.equal(s.nodes.retry.style.display, "none");
    assert.equal(s.nodes.restore.disabled, false);
    assert.equal(s.requests[1].canceled, 1);
    assert.equal(s.timers[0].cleared, true);
    s.timers[0].callback();
    s.requests[0].onservicecallback('{"returnValue":false,"errorText":"Late failure"}');
    assert.equal(s.state(), "starting", "Completed requests ignore late events");

    s = ready({palmBridge: true});
    assert.equal(s.state(), "ready");
    assert.equal(s.requests.length, 1, "Opening an installed app must not run apply or launch Home");
    assert.equal(s.nodes["status-badge"].textContent, "INSTALLED");
    assert.equal(s.nodes.github.attributes["aria-disabled"], "false");
    assert.match(s.nodes.description.textContent, /Press Home/);
    assert.doesNotMatch(s.nodes["progress-note"].textContent, /opens.*automatically/);
    s.nodes.restore.onclick({isTrusted: true, detail: 0, button: 0});
    s.nodes.restore.onmouseenter({isTrusted: true});
    s.nodes.restore.onmousedown({isTrusted: true, button: 0});
    s.nodes.restore.onclick({isTrusted: true, detail: 0, button: 0});
    assert.equal(s.requests.length, 1, "Hover plus keyboard activation is not a pointer click");
    s.nodes.restore.onmousedown({isTrusted: true, button: 0});
    s.nodes.restore.onclick({isTrusted: false, detail: 1, button: 0});
    assert.equal(s.requests.length, 1, "Synthetic clicks cannot restore");
    s.nodes.restore.onmousedown({isTrusted: true, button: 0});
    s.nodes.restore.onmouseleave();
    s.nodes.restore.onclick({isTrusted: true, detail: 1, button: 0});
    assert.equal(s.requests.length, 1, "Leaving the button cancels pointer arming");
    pointer(s);
    assert.equal(s.state(), "restoring");
    s.nodes.github.onclick(linkClick);
    assert.equal(s.browserRequests.length, 0, "GitHub cannot interrupt stock restoration");
    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[1].action, "restore");
    assert.equal(s.nodes.restore.disabled, true);
    pointer(s);
    assert.equal(s.requests.length, 2, "A restore cannot run twice concurrently");
    s.requests[1].onservicecallback(restoreResult());
    assert.equal(s.state(), "restored");
    assert.equal(s.nodes.github.attributes["aria-disabled"], "false");
    assert.equal(s.nodes.restore.disabled, true);
    assert.match(s.nodes.description.textContent, /restart.*not standby.*uninstall/);
    assert.match(s.nodes.details.textContent, /Recovery:/);
    s.nodes.retry.onclick();
    assert.equal(s.requests[2].action, "apply", "Reinstallation after restore requires an explicit click");
    s.requests[2].onservicecallback(success(false));
    assert.equal(s.state(), "ready");

    s = fixture();
    s.requests[0].onservicecallback(envelope({returnValue: true, state: "restored", archive}));
    assert.equal(s.state(), "restored");
    assert.equal(s.requests.length, 1, "Reopening after restoration must never automatically reinstall");
    s = fixture();
    s.requests[0].onservicecallback(envelope({returnValue: true, state: "restore-needed"}));
    assert.equal(s.state(), "error");
    assert.equal(s.nodes.retry.style.display, "none", "Generic Retry cannot bypass the pointer-only restore gate");
    pointer(s);
    assert.equal(s.requests[1].action, "restore");
    s.requests[1].onservicecallback('{"returnValue":false,"errorText":"Restoration failed"}');
    assert.equal(s.state(), "error");
    assert.match(s.nodes.description.textContent, /Do not uninstall/);
    assert.equal(s.nodes.retry.style.display, "none");
    assert.equal(s.nodes.restore.disabled, false);
    pointer(s);
    s.requests[2].onservicecallback(restoreResult());
    assert.equal(s.state(), "restored");

    s = fixture({missingBridge: true});
    assertFailed(s, /rooted LG B9/);
    s.window.webOSServiceBridge = s.Bridge;
    s.nodes.retry.onclick();
    assert.equal(s.state(), "checking");
    assert.equal(s.nodes.details.textContent, "");
    assert.equal(s.nodes.details.style.display, "none");
    assert.equal(s.nodes.retry.style.display, "none");
    s.requests[0].onservicecallback(installed());
    assert.equal(s.state(), "ready");

    for (const response of [
        '{"returnValue":false,"errorText":"Root service rejected setup"}',
        '{"returnValue":true,"error":"Root service rejected setup"}'
    ]) {
        s = fixture();
        s.requests[0].onservicecallback(response);
        assertFailed(s, /Root service rejected setup/);
        assert.equal(s.requests[0].canceled, 1);
    }
    for (const response of [
        "invalid JSON", "null", '{"returnValue":true,"stdoutString":""}',
        '{"returnValue":true,"stdoutString":"not installer JSON"}',
        envelope({returnValue: true, state: "unknown"}),
        envelope({returnValue: true, state: "installed"}),
        envelope({returnValue: true, state: "restored", archive: "/unverified"}),
        success(true, {returnValue: false})
    ]) {
        s = fixture();
        s.requests[0].onservicecallback(response);
        assertFailed(s, /.+/);
    }
    s = fixture();
    const warning = JSON.parse(installed());
    warning.stderrString = "Root installer error";
    s.requests[0].onservicecallback(JSON.stringify(warning));
    assertFailed(s, /Root installer error/);

    s = fixture();
    const oldRequest = s.requests[0];
    s.timers[0].callback();
    assertFailed(s, /60 seconds.*Reopen/);
    oldRequest.onservicecallback(success());
    assert.equal(s.state(), "error");
    s.nodes.retry.onclick();
    assert.equal(s.requests.length, 2);
    assert.equal(s.state(), "checking");
    oldRequest.onservicecallback(installed());
    s.timers[0].callback();
    assert.equal(s.state(), "checking", "Stale callbacks and timeouts cannot affect a retry");
    assert.equal(s.requests[1].canceled, 0);
    s.requests[1].onservicecallback(installed());
    assert.equal(s.state(), "ready");
    assert.equal(s.requests[1].canceled, 1);

    for (const response of [
        '{"returnValue":true}', '{"returnValue":false,"errorText":"Browser unavailable"}',
        '{"returnValue":true,"error":"Browser unavailable"}',
        'invalid JSON', 'null'
    ]) {
        s = ready();
        s.nodes.github.onclick(linkClick);
        assert.equal(s.browserRequests.length, 1);
        assert.equal(s.nodes.github.attributes["aria-disabled"], "true");
        pointer(s);
        assert.equal(s.requests.length, 1, "Restore cannot start while the browser is launching");
        s.nodes.github.onclick(linkClick);
        assert.equal(s.browserRequests.length, 1);
        s.browserRequests[0].onservicecallback(response);
        assert.equal(s.state(), "ready", "Opening GitHub does not alter installation state");
        assert.equal(s.nodes.restore.disabled, false);
        assert.equal(s.nodes.github.attributes["aria-disabled"], "false");
        assert.equal(s.browserRequests[0].canceled, 1);
        assert.equal(s.nodes["github-status"].textContent,
            response === '{"returnValue":true}' ? "" : "Could not open GitHub. Try again.");
    }
    s = ready();
    s.nodes.github.onclick(linkClick);
    s.timers[1].callback();
    assert.match(s.nodes["github-status"].textContent, /Could not open GitHub/);
    s.browserRequests[0].onservicecallback('{"returnValue":true}');
    assert.match(s.nodes["github-status"].textContent, /Could not open GitHub/);
    s.nodes.github.onclick(linkClick);
    s.browserRequests[1].onservicecallback('{"returnValue":true}');
    assert.equal(s.nodes["github-status"].textContent, "");
    s = ready({browserCallError: "Browser launch failed"});
    s.nodes.github.onclick(linkClick);
    assert.match(s.nodes["github-status"].textContent, /Could not open GitHub/);
    assert.equal(s.state(), "ready");
    s = fixture({missingBridge: true});
    const previous = prevented;
    s.nodes.github.onclick(linkClick);
    assert.equal(prevented, previous, "Browser preview keeps the normal external link");

    for (const options of [{constructorError: "Bridge unavailable"}, {callError: "Bridge call failed"}]) {
        s = fixture(options);
        assertFailed(s, /Bridge/);
    }
    s = fixture({cancelError: "Bridge cleanup failed"});
    s.requests[0].onservicecallback(installed());
    assert.equal(s.state(), "ready", "A cleanup error does not invalidate confirmed installation");
    assert.ok(s.errors.some(message => /request cleanup.*Bridge cleanup failed/.test(message)));

    s = ready();
    pointer(s);
    s.timers[1].callback();
    assert.equal(s.state(), "error");
    assert.match(s.nodes.details.textContent, /180 seconds/);
    assert.equal(s.nodes.retry.style.display, "none");
    const timedOut = s.requests[1];
    pointer(s);
    timedOut.onservicecallback(restoreResult());
    assert.equal(s.state(), "restoring");
    s.requests[2].onservicecallback(envelope({returnValue: true, restored: true, archive}));
    assert.equal(s.state(), "error", "Unverified restore cannot report success");
};

if (require.main === module) {
    module.exports();
    console.log("PASS setup UI states, native failures, timeout, retry and stale-event isolation");
}
