(function () {
    "use strict";
    var APP = "/media/developer/apps/usr/palm/applications/org.webosbrew.b9homecustom";
    var bridge = null;
    var busy = false;
    var timer = null;
    var canRestore = false;
    var retryAction = "status";
    var hovered = false;
    var pressed = false;
    var githubBridge = null;
    var githubTimer = null;

    function node(id) { return document.getElementById(id); }
    function updateActions() {
        var disabled = busy || githubBridge !== null;
        node("github").setAttribute("aria-disabled", disabled ? "true" : "false");
        node("github").setAttribute("tabindex", disabled ? "-1" : "0");
        node("restore").disabled = disabled || !canRestore;
        node("retry").disabled = disabled;
    }
    function cancelBridge(pending) {
        if (pending && typeof pending.cancel === "function") {
            try { pending.cancel(); }
            catch (error) { console.error("LG webOS Glass Home request cleanup: " + error.message); }
        }
    }
    function finishGitHub(error) {
        clearTimeout(githubTimer);
        var pending = githubBridge;
        githubBridge = null;
        cancelBridge(pending);
        updateActions();
        node("github-status").textContent = error ? "Could not open GitHub. Try again." : "";
        if (error) console.error("LG webOS Glass Home GitHub link: " + error);
    }
    node("github").onclick = function (event) {
        if (busy || githubBridge !== null) { event.preventDefault(); return; }
        var Constructor = window.webOSServiceBridge || window.PalmServiceBridge;
        if (typeof Constructor !== "function") return;
        event.preventDefault();
        node("github-status").textContent = "";
        try {
            var current = new Constructor();
            githubBridge = current;
            updateActions();
            githubTimer = setTimeout(function () {
                if (githubBridge === current) finishGitHub("The TV browser did not respond.");
            }, 10000);
            current.onservicecallback = function (message) {
                if (githubBridge !== current) return;
                try {
                    var response = JSON.parse(message);
                    if (response.returnValue !== true || response.error) {
                        throw new Error(response.errorText || response.error || "The TV could not open its browser.");
                    }
                    finishGitHub();
                } catch (error) { finishGitHub(error.message); }
            };
            current.call("luna://com.webos.applicationManager/launch", JSON.stringify({
                id: "com.webos.app.browser", params: {target: node("github").getAttribute("href")}
            }));
        } catch (error) { finishGitHub(error.message); }
    };
    function view(state, title, description) {
        document.body.setAttribute("data-state", state);
        node("progress-panel").setAttribute("aria-busy", busy ? "true" : "false");
        node("status").textContent = title;
        node("description").textContent = description;
        node("activity").setAttribute("aria-label", title);
        node("activity-label").textContent = state === "restoring" ? "RESTORE + VERIFY" :
            state === "checking" ? "CHECK INSTALLATION" : "APPLY + VERIFY";
        node("activity-next").textContent = state === "restoring" ? "NEXT: FULL TV RESTART" :
            state === "checking" ? "NEXT: SETUP OR RESTORE" : "NEXT: OPEN HOME";
        node("status-badge").textContent = {
            checking: "CHECKING", working: "IN PROGRESS", starting: "HOME IS STARTING",
            ready: "INSTALLED", restoring: "RESTORING", restored: "RESTORED", error: "NEEDS ATTENTION"
        }[state];
        node("automatic-label").textContent = state === "restored" ? "RESTART REQUIRED" :
            state === "ready" ? "SETUP AVAILABLE" : state === "error" ? "NEEDS ATTENTION" : "PLEASE KEEP TV ON";
        node("intro-message").textContent = state === "restored" ?
            "Stock configuration is restored. Fully restart your TV before uninstalling this app." :
            "First-time setup is automatic. Reopen this app whenever you need to restore stock Home.";
        node("progress-note").textContent = state === "restored" ?
            "Your saved media and recovery backups have been retained." :
            state === "restoring" ? "Do not uninstall or turn off the TV during restoration." :
            state === "ready" ? "Press Home to return, or restore the previous configuration below." :
            "First-time setup opens your custom Home automatically.";
        node("quick-start-label").textContent = "Q Start+ standby";
        node("quick-start-description").textContent = state === "restored" ? "Original TV setting restored" :
            state === "ready" ? "Your current TV setting is preserved" :
            state === "error" || state === "restoring" ? "No new setting confirmed" : "Enabled during setup";
        node("restore").disabled = busy || !canRestore;
        node("restore-hint").textContent = state === "restored" ? "Restoration complete" :
            busy ? "Wait for the current operation to finish" : "Point here, then click to begin";
        node("retry").style.display = "none";
        node("details").textContent = "";
        node("details").style.display = "none";
        pressed = false;
        updateActions();
    }
    function details(message) {
        node("details").textContent = message;
        node("details").style.display = "block";
    }
    function stopRequest() {
        busy = false;
        clearTimeout(timer);
        var pending = bridge;
        bridge = null;
        cancelBridge(pending);
    }
    function failed(message, action) {
        stopRequest();
        retryAction = action;
        view("error", action === "restore" ? "Restoration needs attention." : "Setup needs attention.",
            action === "restore" ? "Restoration is not confirmed. Do not uninstall this app; retry Restore below." :
                "Setup did not finish. No success was reported.");
        details(message);
        if (action !== "restore") {
            node("retry").textContent = "Retry setup";
            node("retry").style.display = "inline-block";
            node("retry").focus();
        }
        console.error("LG webOS Glass Home: " + message);
    }
    function restored(result) {
        if (result.restored !== true || result.restartRequired !== true || typeof result.archive !== "string" ||
                !/^\/var\/lib\/webosbrew\/b9-home-custom-restored-[0-9]+-[0-9]+$/.test(result.archive)) {
            throw new Error("The installer did not verify complete stock restoration.");
        }
        canRestore = false;
        view("restored", "Stock Home configuration restored.",
            "Fully restart the TV (not standby), then uninstall this app if you wish.");
        details("Saved wallpapers, preferences and backups are retained.\nRecovery: " + result.archive);
        retryAction = "apply";
        node("retry").textContent = "Set up Glass Home again";
        node("retry").style.display = "inline-block";
    }
    function completed(action, result) {
        if (action === "restore") { restored(result); return; }
        if (action === "status") {
            if (result.state === "not-installed") { request("apply"); return; }
            if (result.state === "restored") {
                restored({restored: true, restartRequired: true, archive: result.archive});
                return;
            }
            canRestore = true;
            if (result.state === "restore-needed") {
                failed("An earlier restoration did not finish. Point to Restore stock Home and click to resume.", "restore");
                return;
            }
            if (result.state === "incomplete") {
                failed("An earlier installation did not finish. Retry setup, or restore the previous configuration below.", "apply");
                return;
            }
            if (result.state !== "installed" || ["on", "off"].indexOf(result.quickStartMode) === -1) {
                canRestore = false;
                throw new Error("The installer returned an unrecognized installation state.");
            }
            view("ready", "Glass Home is installed.",
                "Press Home to return to your screen, or restore the previous configuration below.");
            if (result.quickStartMode === "on") {
                node("quick-start-label").textContent = "Q Start+ enabled";
                node("quick-start-description").textContent = "Fast return from standby";
            }
            return;
        }
        if (result.installed !== true || typeof result.activationScheduled !== "boolean" ||
                typeof result.backup !== "string" || !result.backup) {
            throw new Error("The installer did not confirm successful setup.");
        }
        canRestore = true;
        view(result.activationScheduled ? "starting" : "ready",
            result.activationScheduled ? "Configuration installed. Home is starting." : "Your custom Home is ready.",
            result.activationScheduled ? "Setup is complete. Home will open automatically." : "Press Home to return to your custom screen.");
        node("quick-start-label").textContent = "Q Start+ enabled";
        node("quick-start-description").textContent = "Fast return from standby";
        details("The settings website, wallpapers, boot/wake support and screensaver are installed.\nBackup: " + result.backup);
    }
    function request(action) {
        if (busy || githubBridge !== null) return;
        var Constructor = window.webOSServiceBridge || window.PalmServiceBridge;
        if (typeof Constructor !== "function") {
            failed("This package needs a rooted LG B9 with an elevated Homebrew Channel service.", action);
            return;
        }
        busy = true;
        view(action === "restore" ? "restoring" : action === "status" ? "checking" : "working",
            action === "restore" ? "Restoring your previous configuration" :
                action === "status" ? "Checking your Home configuration" : "Applying & verifying configuration",
            action === "restore" ? "This can take a few minutes. Please keep your TV on." :
                "This can take up to a minute. Please keep your TV on.");
        try {
            var current = new Constructor();
            bridge = current;
            var timeout = action === "restore" ? 180000 : 60000;
            timer = setTimeout(function () {
                if (busy && bridge === current) {
                    failed("Homebrew did not finish within " + (timeout / 1000) +
                        " seconds. Reopen this app to check the current state before retrying. Do not uninstall it yet.", action);
                }
            }, timeout);
            current.onservicecallback = function (message) {
                if (!busy || bridge !== current) return;
                try {
                    var response = JSON.parse(message);
                    if (response.returnValue !== true || response.error) {
                        throw new Error(response.error || response.errorText || "The rooted Homebrew service rejected the request.");
                    }
                    if (response.stderrString) throw new Error(response.stderrString);
                    var lines = (response.stdoutString || "").trim().split(/\r?\n/);
                    var result = JSON.parse(lines[lines.length - 1]);
                    if (result.returnValue !== true) throw new Error(result.errorText || "The installer did not confirm success.");
                    stopRequest();
                    completed(action, result);
                } catch (error) { failed(error.message, action); }
            };
            current.call("luna://org.webosbrew.hbchannel.service/exec", JSON.stringify({
                command: "flock -x /var/lock/b9-home-package.lock /usr/bin/node " + APP + "/installer.js " + action
            }));
        } catch (error) { failed(error.message, action); }
    }
    node("retry").onclick = function () { request(retryAction); };
    node("restore").onmouseenter = function (event) { hovered = event.isTrusted === true; };
    node("restore").onmousemove = node("restore").onmouseenter;
    node("restore").onmouseleave = function () { hovered = false; pressed = false; };
    node("restore").onmousedown = function (event) {
        pressed = hovered && event.isTrusted === true && event.button === 0 && !busy && canRestore;
    };
    node("restore").onclick = function (event) {
        var allowed = hovered && pressed && event.isTrusted === true && event.detail > 0 && event.button === 0;
        pressed = false;
        if (allowed && !busy && canRestore && githubBridge === null) request("restore");
    };
    request("status");
}());
