"use strict";

(function () {
    var state;
    var locations = [];
    var searchGeneration = 0;
    var saveBusy = false;
    var uploadBusy = false;
    var saveSpinnerTimer;
    function element(id) { return document.getElementById(id); }
    function status(message, error) {
        if (element("status").textContent !== message) element("status").textContent = message;
        element("status").className = error ? "error" : "";
    }
    function updateDockPreview() {
        var opacity = Number(element("dock-opacity").value) / 100;
        var color = element("dock-color").value;
        element("opacity-label").textContent = Math.round(opacity * 100) + "%";
        element("dock-opacity").setAttribute("aria-valuetext", element("opacity-label").textContent);
        element("color-label").textContent = color.toUpperCase();
        element("dock-preview").style.backgroundColor = "rgba(" +
            parseInt(color.substr(1, 2), 16) + "," + parseInt(color.substr(3, 2), 16) + "," +
            parseInt(color.substr(5, 2), 16) + "," + opacity + ")";
        element("dock-preview").style.borderColor = element("show-dock-border").checked ? "" : "transparent";
        var size = Number(element("dock-size").value);
        element("size-label").textContent = size + "%";
        element("dock-size").setAttribute("aria-valuetext", size + "%");
        element("dock-preview").style.zoom = String(0.6 + size / 100);
    }
    function updateScreensaverLabel() {
        var seconds = Number(element("screensaver-seconds").value);
        var minutes = Math.floor(seconds / 60);
        var remainder = seconds % 60;
        var label = minutes ? minutes + (minutes === 1 ? " minute" : " minutes") : "";
        if (remainder) label += (label ? " " : "") + remainder + (remainder === 1 ? " second" : " seconds");
        element("screensaver-label").textContent = label;
        element("screensaver-seconds").setAttribute("aria-valuetext", label);
    }
    function request(route, options) {
        return fetch(route, options).then(function (response) {
            return response.json().then(function (data) {
                if (!response.ok) throw new Error(data.error || "Request failed.");
                return data;
            });
        });
    }
    function backgroundMode() {
        return element("background-type").querySelector("input:checked").value;
    }
    function renderBackground() {
        var live = backgroundMode() === "video";
        var background = state && (live ? state.liveWallpaper : state.wallpaper);
        var preview = element("video-preview");
        element("preview").hidden = live || !background;
        preview.hidden = !live || !background;
        element("preview-placeholder").hidden = !!background;
        element("image-layout").hidden = live;
        element("image").accept = live ? "video/mp4,.mp4" : "image/*";
        element("upload-title").textContent = live ? "Choose an MP4 video" : "Choose an image";
        element("image-name").textContent = element("image").files.length ?
            element("image").files[0].name : live ? "H.264 MP4, up to 150 MB." : "Resized on your device.";
        element("layout-hint").textContent = live ?
            "H.264 MP4, up to 3840 x 2160 (4K), 60 fps and 150 MB. 24-30 fps is recommended. " +
            "Loops silently while Home is visible and stops for apps and the screensaver. Your saved image is kept." :
            "Fit stretches the whole image to fill the screen. Crop keeps its proportions and trims the edges. " +
            "Each image upload replaces the previous image. Your saved video is kept.";
        if (!live || !background) {
            if (preview.hasAttribute("src")) {
                preview.pause();
                preview.removeAttribute("src");
                preview.load();
            }
        } else {
            var source = "/live-background?v=" + background.version;
            if (preview.getAttribute("src") !== source) {
                preview.muted = true;
                preview.src = source;
            }
        }
        if (!live && background) element("preview").src = "/background?v=" + background.version;
    }
    function showWeather(data) {
        var weather = data.weather;
        element("weather-status").textContent = weather.status === "ready" ?
            weather.location + ": " + weather.temperature + "\u00b0" + weather.unit + ", " + weather.description :
            weather.status === "error" ? weather.error :
            weather.status === "loading" ? "Loading current conditions..." :
            "Weather is off until a location is selected and saved.";
    }
    function selectLocation(value) {
        element("location").value = value;
        Array.prototype.forEach.call(element("city-results").querySelectorAll("input"), function (input) {
            input.checked = input.value === value;
            input.parentNode.className = "city-result" + (input.checked ? " selected" : "");
        });
    }
    function setLocations(values, selected, showResults) {
        locations = values;
        var select = element("location");
        var results = element("city-results");
        results.textContent = "";
        results.hidden = !showResults || !values.length;
        select.textContent = "";
        var placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = values.length ? "Choose a location" : "No location selected";
        select.appendChild(placeholder);
        values.forEach(function (location, index) {
            var option = document.createElement("option");
            option.value = String(index);
            option.textContent = location.label;
            select.appendChild(option);
            if (showResults) {
                var row = document.createElement("label");
                row.className = "city-result";
                var radio = document.createElement("input");
                radio.type = "radio";
                radio.name = "city-result";
                radio.value = String(index);
                radio.addEventListener("change", function () {
                    selectLocation(this.value);
                    status("Location selected. Enable weather if needed, then save your changes.");
                });
                var name = document.createElement("span");
                name.textContent = location.label;
                row.appendChild(radio);
                row.appendChild(name);
                results.appendChild(row);
            }
        });
        selectLocation(selected === undefined ? "" : String(selected));
    }
    function render(data) {
        searchGeneration++;
        state = data;
        var settings = data.settings;
        element("dock-opacity").value = Math.round(settings.dockOpacity * 100);
        element("dock-size").value = settings.dockSize;
        element("dock-color").value = settings.dockColor;
        element("show-dock-border").checked = settings.showDockBorder;
        element("show-weather-border").checked = settings.showWeatherBorder;
        element("show-input-border").checked = settings.showInputBorder;
        element("show-hint-border").checked = settings.showHintBorder;
        element("input-text-opacity").checked = settings.inputTextOpacity;
        element("hint-follows-inputs").checked = settings.hintFollowsInputs;
        element("hide-inputs-button").checked = settings.hideInputsButton;
        element("hide-hint-button").checked = settings.hideHintButton;
        updateDockPreview();
        element("wallpaper-enabled").checked = settings.wallpaperEnabled;
        element("wallpaper-enabled").disabled = saveBusy;
        element("show-clock").checked = settings.showClock;
        element("show-date").checked = settings.showDate;
        element("clock-24-hour").checked = settings.clock24Hour;
        element("show-weather").checked = settings.showWeather;
        element("show-weather-dock").checked = settings.showWeatherDock;
        element("screensaver-seconds").value = settings.screensaverSeconds;
        element("screensaver-mode").value = settings.screensaverMode;
        updateScreensaverLabel();
        element("unit").value = settings.temperatureUnit;
        setLocations(settings.weatherLocation ? [settings.weatherLocation] : [],
            settings.weatherLocation ? 0 : undefined);
        element("controls").disabled = saveBusy;
        element("save-button").disabled = saveBusy;
        element("connection-state").textContent = "Connected";
        element("connection-state").className = "connection-state connected";
        element("tv-address").textContent = data.urls && data.urls.length ?
            data.urls[0].replace(/^http:\/\//, "") : "Local TV";
        Array.prototype.forEach.call(element("background-type").querySelectorAll("input"), function (input) {
            input.checked = input.value === (settings.wallpaperMode || "image");
        });
        element("background-type").disabled = saveBusy || uploadBusy;
        renderBackground();
        showWeather(data);
    }
    element("dock-opacity").addEventListener("input", updateDockPreview);
    element("dock-size").addEventListener("input", updateDockPreview);
    element("screensaver-seconds").addEventListener("input", updateScreensaverLabel);
    element("dock-color").addEventListener("input", updateDockPreview);
    element("show-dock-border").addEventListener("change", updateDockPreview);
    element("image").addEventListener("change", function () {
        renderBackground();
    });
    element("background-type").addEventListener("change", function () {
        element("image").value = "";
        renderBackground();
        status("Background type selected. Upload a file or save your changes to apply it.");
    });
    element("video-preview").addEventListener("loadedmetadata", function () {
        if (!this.hidden && this.paused && this.currentTime === 0 &&
                isFinite(this.duration) && this.duration > 0) {
            this.currentTime = Math.min(0.1, this.duration / 2);
        }
    });
    element("video-preview").addEventListener("error", function () {
        if (this.hasAttribute("src")) status("This browser cannot preview the uploaded MP4.", true);
    });
    element("city").addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.keyCode === 13) {
            event.preventDefault();
            element("search").click();
        }
    });
    element("city").addEventListener("input", function () {
        searchGeneration++;
        element("city-results").hidden = true;
        status("Press Find city to search for matching locations.");
    });
    element("location").addEventListener("change", function () { selectLocation(this.value); });
    element("search").addEventListener("click", function () {
        var button = this;
        var query = element("city").value.trim();
        if (query.length < 2) {
            status("Enter at least two characters to find your city.", true);
            element("city").focus();
            return;
        }
        var generation = ++searchGeneration;
        button.disabled = true;
        button.textContent = "Finding...";
        button.setAttribute("aria-busy", "true");
        element("city-results").hidden = true;
        status("Finding matching cities...");
        request("/api/locations?q=" + encodeURIComponent(query)).then(function (data) {
            if (generation !== searchGeneration) return;
            setLocations(data.locations, data.locations.length === 1 ? 0 : undefined, true);
            status(data.locations.length ? data.locations.length + " matching location" +
                (data.locations.length === 1 ? "" : "s") + ". Choose yours below, then save." :
                "No matches. Try a shorter city name or City, country.");
        }).catch(function (error) {
            if (generation === searchGeneration) status(error.message, true);
        }).then(function () {
            button.disabled = false;
            button.textContent = "Find city";
            button.setAttribute("aria-busy", "false");
        });
    });
    element("settings-form").addEventListener("submit", function (event) {
        event.preventDefault();
        if (!state || saveBusy || uploadBusy) return;
        var selected = element("location").value;
        var settings = {
            wallpaperEnabled: element("wallpaper-enabled").checked,
            wallpaperMode: backgroundMode(),
            dockOpacity: Number(element("dock-opacity").value) / 100,
            dockSize: Number(element("dock-size").value),
            dockColor: element("dock-color").value,
            showDockBorder: element("show-dock-border").checked,
            showWeatherBorder: element("show-weather-border").checked,
            showInputBorder: element("show-input-border").checked,
            showHintBorder: element("show-hint-border").checked,
            inputTextOpacity: element("input-text-opacity").checked,
            hintFollowsInputs: element("hint-follows-inputs").checked,
            hideInputsButton: element("hide-inputs-button").checked,
            hideHintButton: element("hide-hint-button").checked,
            showClock: element("show-clock").checked,
            showDate: element("show-date").checked,
            clock24Hour: element("clock-24-hour").checked,
            showWeather: element("show-weather").checked,
            showWeatherDock: element("show-weather-dock").checked,
            screensaverSeconds: Number(element("screensaver-seconds").value),
            screensaverMode: element("screensaver-mode").value,
            temperatureUnit: element("unit").value,
            weatherLocation: selected === "" ? null : locations[Number(selected)]
        };
        saveBusy = true;
        element("save-spinner").hidden = false;
        clearTimeout(saveSpinnerTimer);
        saveSpinnerTimer = setTimeout(function () { element("save-spinner").hidden = true; }, 2000);
        element("controls").disabled = true;
        element("wallpaper-enabled").disabled = true;
        element("background-type").disabled = true;
        element("save-button").disabled = true;
        element("save-label").textContent = "Saving...";
        element("save-button").setAttribute("aria-busy", "true");
        status("Saving...");
        request("/api/settings", {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-Home-Settings": "1"},
            body: JSON.stringify(settings)
        }).then(function (data) {
            render(data);
            status("Saved. Home updates automatically within five seconds.");
        }).catch(function (error) { status(error.message, true); }).then(function () {
            saveBusy = false;
            element("controls").disabled = false;
            element("wallpaper-enabled").disabled = false;
            element("background-type").disabled = false;
            element("save-button").disabled = false;
            element("save-label").textContent = "Save changes";
            element("save-button").setAttribute("aria-busy", "false");
        });
    });
    element("upload-form").addEventListener("submit", function (event) {
        event.preventDefault();
        if (uploadBusy || saveBusy) return;
        var file = element("image").files[0];
        if (!file) return;
        if (!state || !state.display) {
            status("Wait for the TV settings to load, or refresh this page.", true);
            return;
        }
        var button = this.querySelector("button");
        var mode = element("background-mode").value;
        var live = backgroundMode() === "video";
        if (live && file.size > 150 * 1024 * 1024) {
            status("MP4 wallpapers must be at most 150 MB.", true);
            return;
        }
        uploadBusy = true;
        element("background-type").disabled = true;
        element("image").disabled = true;
        element("save-button").disabled = true;
        button.disabled = true;
        button.textContent = "Preparing...";
        button.setAttribute("aria-busy", "true");
        status(live ? "Uploading MP4 to the TV..." : "Resizing image for the TV...");
        (live ? Promise.resolve(file) : HomeImage.prepare(file, state.display, mode)).then(function (prepared) {
            status(live ? "Uploading MP4 to the TV..." : "Uploading prepared background...");
            button.textContent = "Uploading...";
            return request(live ? "/api/live-background" : "/api/background", {
                method: "POST",
                headers: {"Content-Type": live ? "video/mp4" : prepared.type, "X-Home-Settings": "1"},
                body: prepared
            });
        }).then(function (data) {
            render(data);
            status("Background replaced. Home updates automatically within five seconds.");
        }).catch(function (error) { status(error.message, true); }).then(function () {
            uploadBusy = false;
            element("background-type").disabled = false;
            element("image").disabled = false;
            element("save-button").disabled = false;
            button.disabled = false;
            button.textContent = "Upload background";
            button.setAttribute("aria-busy", "false");
        });
    });
    request("/api/state").then(function (data) {
        render(data);
        status("Connected to the TV.");
    }).catch(function (error) {
        element("connection-state").textContent = "TV unavailable";
        element("connection-state").className = "connection-state offline";
        status("Cannot load Home settings: " + error.message, true);
    });
    setInterval(function () {
        if (!state || !state.settings.showWeather) return;
        request("/api/state").then(showWeather).catch(function (error) {
            status("Cannot refresh weather: " + error.message, true);
        });
    }, 10000);
})();
