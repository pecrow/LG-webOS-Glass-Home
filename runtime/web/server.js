"use strict";

var fs = require("fs");
var path = require("path");
var http = require("http");
var os = require("os");
var url = require("url");
var childProcess = require("child_process");
var atomicWrite = require("./storage");
var video = require("./video");
var wakeHome = require("./wake-home");
var pictureContext = require("./picture-context");
var idlePolicy = require("./idle-policy");

var MAX_IMAGE = 8 * 1024 * 1024;
var DEFAULTS = {
    wallpaperEnabled: true,
    wallpaperMode: "image",
    dockOpacity: 0.60,
    dockColor: "#252c36",
    showDockBorder: true,
    showWeatherBorder: true,
    showInputBorder: true,
    showHintBorder: true,
    dockSize: 40,
    inputTextOpacity: false,
    hintFollowsInputs: false,
    hideInputsButton: false,
    hideHintButton: false,
    showClock: true,
    showDate: true,
    clock24Hour: false,
    showWeather: false,
    showWeatherDock: false,
    screensaverSeconds: 120,
    screensaverMode: "lg",
    temperatureUnit: "fahrenheit",
    weatherLocation: null
};
var OPTIONAL_SETTINGS = ["showDockBorder", "inputTextOpacity", "showWeatherDock", "hintFollowsInputs",
    "showWeatherBorder", "showInputBorder", "showHintBorder", "dockSize", "screensaverSeconds", "screensaverMode",
    "hideInputsButton", "hideHintButton", "wallpaperMode"];

function problem(status, message) {
    var error = new Error(message);
    error.status = status;
    return error;
}

function validateSettings(value, previous) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw problem(400, "Settings must be an object.");
    }
    var keys = Object.keys(DEFAULTS);
    if (Object.keys(value).some(function (key) { return keys.indexOf(key) === -1; })) {
        throw problem(400, "Provide all supported settings, without extra fields.");
    }
    value = JSON.parse(JSON.stringify(value));
    keys.forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            if (OPTIONAL_SETTINGS.indexOf(key) === -1) {
                throw problem(400, "Missing setting: " + key);
            }
            if (previous) value[key] = previous[key];
            else if (key === "showWeatherBorder" || key === "showInputBorder") value[key] = value.showDockBorder;
            else if (key === "showHintBorder") value[key] = value.hintFollowsInputs ? value.showDockBorder : true;
            else value[key] = DEFAULTS[key];
        }
        if (typeof DEFAULTS[key] === "boolean" && typeof value[key] !== "boolean") {
            throw problem(400, key + " must be a boolean.");
        }
    });
    if (typeof value.dockOpacity !== "number" || !isFinite(value.dockOpacity) ||
            value.dockOpacity < 0 || value.dockOpacity > 1) {
        throw problem(400, "Dock opacity must be between 0 and 1.");
    }
    if (typeof value.dockColor !== "string" || !/^#[0-9a-f]{6}$/i.test(value.dockColor)) {
        throw problem(400, "Choose a six-digit dock color.");
    }
    if (typeof value.dockSize !== "number" || !isFinite(value.dockSize) ||
            value.dockSize % 1 !== 0 || value.dockSize < 0 || value.dockSize > 100) {
        throw problem(400, "Dock size must be a whole number between 0 and 100.");
    }
    if (typeof value.screensaverSeconds !== "number" || !isFinite(value.screensaverSeconds) ||
            value.screensaverSeconds % 1 !== 0 || value.screensaverSeconds < 10 || value.screensaverSeconds > 300) {
        throw problem(400, "Screensaver timer must be between 10 and 300 seconds.");
    }
    if (["lg", "dvd"].indexOf(value.screensaverMode) === -1) {
        throw problem(400, "Choose LG Default or DVD bounce.");
    }
    if (["image", "video"].indexOf(value.wallpaperMode) === -1) {
        throw problem(400, "Choose Image or Live wallpaper.");
    }
    if (["fahrenheit", "celsius"].indexOf(value.temperatureUnit) === -1) {
        throw problem(400, "Choose Fahrenheit or Celsius.");
    }
    var location = value.weatherLocation;
    if (location !== null) {
        if (typeof location !== "object" || Array.isArray(location) ||
                Object.keys(location).sort().join(",") !== "label,latitude,longitude" ||
                typeof location.label !== "string" || !location.label.trim() ||
                location.label.length > 160 ||
                typeof location.latitude !== "number" || !isFinite(location.latitude) ||
                Math.abs(location.latitude) > 90 ||
                typeof location.longitude !== "number" || !isFinite(location.longitude) ||
                Math.abs(location.longitude) > 180) {
            throw problem(400, "Choose a valid weather location.");
        }
    }
    if (value.showWeather && location === null) {
        throw problem(400, "Choose a weather location before enabling weather.");
    }
    return JSON.parse(JSON.stringify(value));
}

function imageInfo(buffer) {
    var width, height, offset, length, marker, mime;
    if (buffer.length >= 45 &&
            buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
        if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
            throw problem(415, "Invalid PNG header.");
        }
        width = buffer.readUInt32BE(16);
        height = buffer.readUInt32BE(20);
        offset = 8;
        var hasData = false;
        var hasEnd = false;
        while (offset + 12 <= buffer.length) {
            length = buffer.readUInt32BE(offset);
            if (length > buffer.length - offset - 12) {
                throw problem(415, "Truncated PNG.");
            }
            marker = buffer.toString("ascii", offset + 4, offset + 8);
            if (marker === "IDAT") hasData = true;
            offset += length + 12;
            if (marker === "IEND") {
                hasEnd = length === 0 && offset === buffer.length;
                break;
            }
        }
        if (!hasData || !hasEnd) throw problem(415, "Incomplete PNG.");
        mime = "image/png";
    } else if (buffer.length > 12 && buffer[0] === 255 && buffer[1] === 216 &&
            buffer[buffer.length - 2] === 255 && buffer[buffer.length - 1] === 217) {
        offset = 2;
        while (offset + 4 <= buffer.length) {
            if (buffer[offset++] !== 255) throw problem(415, "Invalid JPEG marker.");
            while (offset < buffer.length && buffer[offset] === 255) offset++;
            marker = buffer[offset++];
            if (marker === 218 || marker === 217) break;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            if (offset + 2 > buffer.length) throw problem(415, "Truncated JPEG.");
            length = buffer.readUInt16BE(offset);
            if (length < 2 || offset + length > buffer.length) {
                throw problem(415, "Truncated JPEG.");
            }
            if ([192, 193, 194].indexOf(marker) !== -1) {
                if (length < 8) throw problem(415, "Invalid JPEG dimensions.");
                height = buffer.readUInt16BE(offset + 3);
                width = buffer.readUInt16BE(offset + 5);
                break;
            }
            offset += length;
        }
        mime = "image/jpeg";
    } else {
        throw problem(415, "Upload a JPEG or PNG image.");
    }
    if (!width || !height || width > 4096 || height > 4096 || width * height > 16777216) {
        throw problem(415, "Image dimensions must be at most 4096 x 4096.");
    }
    return {mime: mime, width: width, height: height};
}

function addresses() {
    var interfaces = os.networkInterfaces();
    var result = [];
    Object.keys(interfaces).sort(function (a, b) {
        return (/^(eth|wlan|en)/.test(b) ? 1 : 0) - (/^(eth|wlan|en)/.test(a) ? 1 : 0);
    }).forEach(function (name) {
        if (/^(lo|tun|tap|docker|veth)/.test(name)) return;
        interfaces[name].forEach(function (entry) {
            if (!entry.internal && entry.family === "IPv4" &&
                    entry.address.indexOf("169.254.") !== 0) result.push(entry.address);
        });
    });
    return result;
}

function privateAddress(address) {
    address = (address || "").replace(/^::ffff:/, "");
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(address);
}

function readBody(request, maximum, callback) {
    var chunks = [];
    var size = 0;
    var finished = false;
    function finish(error, value) {
        if (finished) return;
        finished = true;
        callback(error, value);
    }
    if (request.headers["content-length"] &&
            (!/^\d+$/.test(request.headers["content-length"]) ||
            Number(request.headers["content-length"]) > maximum)) {
        request.resume();
        finish(problem(413, "Upload is too large."));
        return;
    }
    request.on("data", function (chunk) {
        if (finished) return;
        size += chunk.length;
        if (size > maximum) {
            chunks = [];
            finish(problem(413, "Upload is too large."));
        } else {
            chunks.push(chunk);
        }
    });
    request.on("end", function () {
        if (!finished) finish(null, Buffer.concat(chunks, size));
    });
    request.on("error", finish);
    request.on("aborted", function () { finish(problem(400, "Upload interrupted.")); });
}

function fetchJSON(target, callback) {
    childProcess.execFile(process.env.HOME_CUSTOM_CURL || "curl", [
        "--fail", "--silent", "--show-error", "--max-time", "12",
        "--max-filesize", "262144", "--proto", "=https", target
    ], {timeout: 15000, maxBuffer: 262144}, function (error, stdout) {
        if (error) {
            console.error("Weather request failed: " + (error.code || error.message));
            callback(problem(502, "Weather service is unavailable. Please try again."));
            return;
        }
        var value;
        try {
            value = JSON.parse(stdout);
        } catch (parseError) {
            console.error("Invalid weather response: " + parseError.message);
            callback(problem(502, "Weather service returned an invalid response."));
            return;
        }
        callback(null, value);
    });
}

function weatherDescription(code, isDay) {
    if (code === 0) return isDay ? "Sunny" : "Clear";
    if (code === 1) return isDay ? "Mostly sunny" : "Mostly clear";
    if (code === 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code >= 51 && code <= 57) return "Drizzle";
    if (code >= 61 && code <= 67) return "Rain";
    if (code >= 71 && code <= 77) return "Snow";
    if (code >= 80 && code <= 82) return "Rain showers";
    if (code === 85 || code === 86) return "Snow showers";
    if (code >= 95 && code <= 99) return "Thunderstorm";
    return "Weather";
}

function normalizeWeather(data, location, unit) {
    var codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
        71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    function number(value) { return typeof value === "number" && isFinite(value); }
    function incomplete() { throw problem(502, "Weather service returned incomplete conditions or forecast."); }
    if (!data || !data.current || !number(data.current.temperature_2m) ||
            codes.indexOf(data.current.weather_code) === -1 ||
            [0, 1].indexOf(data.current.is_day) === -1 || !data.daily) incomplete();
    var daily = data.daily;
    ["time", "weather_code", "temperature_2m_max", "temperature_2m_min"].forEach(function (key) {
        if (!Array.isArray(daily[key]) || daily[key].length < 8) incomplete();
    });
    if (daily.precipitation_probability_max !== undefined &&
            (!Array.isArray(daily.precipitation_probability_max) ||
            daily.precipitation_probability_max.length < 8)) incomplete();
    var previousDate;
    var days = daily.time.slice(0, 8).map(function (date, index) {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) incomplete();
        var parsed = new Date(date + "T12:00:00Z");
        if (!isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ||
                (previousDate !== undefined && parsed.getTime() - previousDate !== 86400000)) incomplete();
        previousDate = parsed.getTime();
        var high = daily.temperature_2m_max[index];
        var low = daily.temperature_2m_min[index];
        var code = daily.weather_code[index];
        var rain = daily.precipitation_probability_max ? daily.precipitation_probability_max[index] : null;
        if (!number(high) || !number(low) || high < low || codes.indexOf(code) === -1 ||
                (rain !== null && (!number(rain) || rain < 0 || rain > 100))) incomplete();
        return {
            date: date, day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()],
            code: code, high: Math.round(high), low: Math.round(low),
            rainChance: rain === null ? null : Math.round(rain)
        };
    });
    return {
        status: "ready", temperature: Math.round(data.current.temperature_2m),
        unit: unit === "fahrenheit" ? "F" : "C",
        code: data.current.weather_code, isDay: data.current.is_day === 1,
        description: weatherDescription(data.current.weather_code, data.current.is_day === 1),
        high: days[0].high, low: days[0].low, forecast: days.slice(1),
        location: location.label, updatedAt: new Date().toISOString()
    };
}

function findLocations(query, requestJSON, callback) {
    function lookup(name, complete) {
        requestJSON("https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&name=" +
            encodeURIComponent(name), function (error, data) {
            if (error) { complete(error); return; }
            if (!data || typeof data !== "object" || data.error ||
                    (data.results !== undefined && !Array.isArray(data.results))) {
                complete(problem(502, "Location service returned an invalid response."));
                return;
            }
            complete(null, data.results || []);
        });
    }
    function finish(error, entries, suggested) {
        if (error) { callback(error); return; }
        var locations = [];
        var seen = {};
        try {
            entries.forEach(function (entry) {
                if (!entry || typeof entry.name !== "string" || !entry.name.trim() ||
                        typeof entry.latitude !== "number" || !isFinite(entry.latitude) ||
                        Math.abs(entry.latitude) > 90 || typeof entry.longitude !== "number" ||
                        !isFinite(entry.longitude) || Math.abs(entry.longitude) > 180) {
                    throw problem(502, "Location service returned an invalid location.");
                }
                var key = entry.latitude + "," + entry.longitude;
                if (seen[key]) return;
                seen[key] = true;
                var parts = [];
                [entry.name, entry.admin3, entry.admin2, entry.admin1, entry.country].forEach(function (part) {
                    if (!part) return;
                    if (typeof part !== "string") throw problem(502, "Location service returned an invalid name.");
                    if (parts.indexOf(part) === -1) parts.push(part);
                });
                locations.push({
                    label: parts.join(", ").slice(0, 130),
                    latitude: entry.latitude, longitude: entry.longitude
                });
            });
            var counts = Object.create(null);
            locations.forEach(function (location) { counts[location.label] = (counts[location.label] || 0) + 1; });
            locations.forEach(function (location) {
                if (counts[location.label] > 1) location.label +=
                    " (" + location.latitude.toFixed(5) + ", " + location.longitude.toFixed(5) + ")";
            });
        } catch (parseError) { callback(parseError); return; }
        callback(null, {locations: locations, suggested: suggested});
    }
    query = query.trim().replace(/\s+/g, " ");
    lookup(query, function (error, entries) {
        if (error || entries.length || query.indexOf(",") !== -1) { finish(error, entries, false); return; }
        var words = query.split(" ");
        var alternatives = [];
        for (var suffix = 1; suffix <= 4 && suffix < words.length; suffix++) {
            alternatives.push(words.slice(0, -suffix).join(" ") + ", " + words.slice(-suffix).join(" "));
        }
        if (!alternatives.length) { finish(null, [], false); return; }
        var remaining = alternatives.length;
        var results = [];
        var firstError;
        alternatives.forEach(function (name, index) {
            lookup(name, function (lookupError, matches) {
                if (lookupError && !firstError) firstError = lookupError;
                results[index] = matches || [];
                if (--remaining) return;
                var combined = [];
                results.forEach(function (values) { combined = combined.concat(values); });
                finish(combined.length ? null : firstError, combined.slice(0, 30), true);
            });
        });
    });
}

function createApp(options) {
    options = options || {};
    var requestJSON = options.fetchJSON || fetchJSON;
    var display = options.display || {
        width: Number(process.env.HOME_CUSTOM_IMAGE_WIDTH || 1920),
        height: Number(process.env.HOME_CUSTOM_IMAGE_HEIGHT || 1080)
    };
    [display.width, display.height].forEach(function (size) {
        if (typeof size !== "number" || !isFinite(size) || size < 1 || size > 4096 || size % 1 !== 0) {
            throw new Error("Unsupported Home image output dimensions.");
        }
    });
    var directory = options.dataDirectory || process.env.HOME_CUSTOM_DATA ||
        path.join(__dirname, "data");
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, 448);
    var configPath = path.join(directory, "settings.json");
    var backgroundPath = path.join(directory, "background");
    var videoPath = path.join(directory, "wallpaper.mp4");
    var videoBackground = fs.existsSync(videoPath) ? video.info(videoPath) : null;
    var videoUploadBusy = false;
    var settings;
    if (fs.existsSync(configPath)) {
        var savedSettings = JSON.parse(fs.readFileSync(configPath, "utf8"));
        var reduceSaverDelay = typeof savedSettings.screensaverSeconds === "number" &&
            savedSettings.screensaverSeconds % 1 === 0 &&
            savedSettings.screensaverSeconds > 300 && savedSettings.screensaverSeconds <= 600;
        if (reduceSaverDelay) savedSettings.screensaverSeconds = 300;
        settings = validateSettings(savedSettings);
        if (reduceSaverDelay) {
            atomicWrite(configPath, JSON.stringify(savedSettings) + "\n");
            console.log("Home screensaver: reduced the previous delay to the five-minute maximum.");
        }
    } else {
        settings = validateSettings(DEFAULTS);
        atomicWrite(configPath, JSON.stringify(settings) + "\n");
    }
    var background = null;
    function refreshBackground() {
        if (!fs.existsSync(backgroundPath)) {
            background = null;
            return;
        }
        var stat = fs.statSync(backgroundPath);
        var info = imageInfo(fs.readFileSync(backgroundPath));
        background = {
            mime: info.mime, width: info.width, height: info.height,
            version: String(stat.mtime.getTime()) + "-" + stat.size
        };
    }
    refreshBackground();
    var idle;
    var wake = options.manageWake ? wakeHome.create({
        base: path.dirname(__dirname),
        homeCard: function () { return idle && idle.state().active ? idle.state().card : null; }
    }) : null;
    idle = options.manageIdle ? idlePolicy.create({
        base: path.dirname(__dirname),
        enabled: function () { return !wake || wake.state().active === true; }
    }) : null;
    var picture = options.managePicture ? pictureContext.create({
        base: path.dirname(__dirname),
        enabled: function () {
            return settings.wallpaperEnabled && settings.wallpaperMode === "video" &&
                (!wake || wake.state().active === true);
        }
    }) : null;
    var weather = {status: "disabled"};
    var weatherGeneration = 0;
    function refreshWeather() {
        var generation = ++weatherGeneration;
        if (!settings.showWeather || !settings.weatherLocation) {
            weather = {status: "disabled"};
            return;
        }
        var location = settings.weatherLocation;
        var unit = settings.temperatureUnit;
        weather = {status: "loading"};
        requestJSON("https://api.open-meteo.com/v1/forecast?latitude=" +
            location.latitude + "&longitude=" + location.longitude +
            "&current=temperature_2m,weather_code,is_day" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
            "&timezone=auto&forecast_days=8&temperature_unit=" + unit,
        function (error, data) {
            if (generation !== weatherGeneration) return;
            if (!error) {
                try {
                    weather = normalizeWeather(data, location, unit);
                } catch (validationError) {
                    error = validationError;
                }
            }
            if (error) {
                weather = {status: "error", error: error.message};
            }
        });
    }
    var publicDirectory = path.join(__dirname, "public");
    var assets = {
        "/": {name: "index.html", type: "text/html; charset=utf-8"},
        "/app.js": {name: "app.js", type: "application/javascript; charset=utf-8"},
        "/image.js": {name: "image.js", type: "application/javascript; charset=utf-8"},
        "/style.css": {name: "style.css", type: "text/css; charset=utf-8"}
    };
    Object.keys(assets).forEach(function (key) {
        assets[key].body = fs.readFileSync(path.join(publicDirectory, assets[key].name));
    });
    var server = http.createServer(function (request, response) {
        var parsed;
        function send(status, body, type) {
            if (response.writableEnded || response.finished || response.destroyed) return;
            response.writeHead(status, {
                "Content-Type": type || "application/json; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Connection": status >= 400 ? "close" : "keep-alive",
                "X-Frame-Options": "DENY",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; " +
                    "style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; " +
                    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            });
            response.end(body);
        }
        function fail(error) {
            request.resume();
            if (!error.status || error.status >= 500) console.error(error.stack || error);
            send(error.status || 500, JSON.stringify({
                error: error.status ? error.message : "Unable to save or read Home settings."
            }));
        }
        function state() {
            var listening = server.address();
            if (!listening) throw problem(503, "Home settings server is restarting.");
            var port = listening.port;
            return {
                service: "native-home-settings",
                display: display,
                settings: settings, wallpaper: background, liveWallpaper: videoBackground, weather: weather,
                power: wake ? wake.state() : null,
                picture: picture ? picture.state() : null,
                idle: idle ? idle.state() : null,
                urls: addresses().map(function (address) {
                    return "http://" + address + (port === 80 ? "" : ":" + port);
                })
            };
        }
        try {
            var listening = server.address();
            if (!listening) throw problem(503, "Home settings server is restarting.");
            if (!privateAddress(request.socket.remoteAddress)) {
                throw problem(403, "This settings page is LAN-only.");
            }
            var host = url.parse("http://" + (request.headers.host || ""));
            if (host.auth || ["localhost", "127.0.0.1"].concat(addresses()).indexOf(host.hostname) === -1 ||
                    Number(host.port || 80) !== listening.port) {
                throw problem(403, "Use the TV's IP address to access Home settings.");
            }
            parsed = url.parse(request.url, true);
            if ((request.method === "GET" || request.method === "HEAD") && parsed.pathname === "/live-background") {
                if (!videoBackground) throw problem(404, "No live wallpaper has been uploaded.");
                video.serve(request, response, videoPath);
                return;
            }
            if (request.method === "GET") {
                if (Object.prototype.hasOwnProperty.call(assets, parsed.pathname)) {
                    var asset = assets[parsed.pathname];
                    send(200, asset.body, asset.type);
                } else if (parsed.pathname === "/api/state") {
                    send(200, JSON.stringify(state()));
                } else if (parsed.pathname === "/api/health") {
                    send(200, JSON.stringify({service: "native-home-settings", ready: true}));
                } else if (parsed.pathname === "/background") {
                    if (!background) throw problem(404, "No custom wallpaper has been uploaded.");
                    send(200, fs.readFileSync(backgroundPath), background.mime);
                } else if (parsed.pathname === "/api/locations") {
                    var query = parsed.query.q;
                    if (typeof query !== "string" || query.trim().length < 2 || query.length > 80) {
                        throw problem(400, "Enter a city name between 2 and 80 characters.");
                    }
                    request.setTimeout(30000);
                    findLocations(query, requestJSON, function (error, result) {
                        if (error) { fail(error); return; }
                        send(200, JSON.stringify(result));
                    });
                } else {
                    throw problem(404, "Not found.");
                }
                return;
            }
            if (request.method !== "POST") throw problem(405, "Method not allowed.");
            if (request.headers["x-home-settings"] !== "1") {
                throw problem(403, "Use the Home settings page to make changes.");
            }
            if (request.headers.origin) {
                var origin = url.parse(request.headers.origin);
                if (origin.protocol !== "http:" || origin.hostname !== host.hostname ||
                        Number(origin.port || 80) !== Number(host.port || 80)) {
                    throw problem(403, "Cross-origin changes are not allowed.");
                }
            }
            if (parsed.pathname === "/api/picture/refresh") {
                readBody(request, 128, function (error, body) {
                    if (error) { fail(error); return; }
                    try {
                        if (!picture) throw problem(503, "Home picture manager is unavailable.");
                        if (body.toString("utf8") !== "{}") throw problem(400, "Invalid Home picture refresh.");
                        picture.refresh(function (refreshError) {
                            if (refreshError) { fail(problem(409, refreshError.message)); return; }
                            send(200, JSON.stringify({refreshed: true}));
                        });
                    } catch (refreshError) { fail(refreshError); }
                });
            } else if (parsed.pathname === "/api/settings") {
                if ((request.headers["content-type"] || "").split(";")[0] !== "application/json") {
                    throw problem(415, "Send settings as JSON.");
                }
                readBody(request, 16384, function (error, body) {
                    if (error) { fail(error); return; }
                    try {
                        var value;
                        try { value = JSON.parse(body.toString("utf8")); }
                        catch (parseError) { throw problem(400, "Invalid settings JSON."); }
                        value = validateSettings(value, settings);
                        var changed = value.showWeather !== settings.showWeather ||
                            value.temperatureUnit !== settings.temperatureUnit ||
                            JSON.stringify(value.weatherLocation) !== JSON.stringify(settings.weatherLocation);
                        atomicWrite(configPath, JSON.stringify(value) + "\n");
                        settings = value;
                        if (changed) refreshWeather();
                        send(200, JSON.stringify(state()));
                    } catch (saveError) { fail(saveError); }
                });
            } else if (parsed.pathname === "/api/background") {
                readBody(request, MAX_IMAGE, function (error, body) {
                    if (error) { fail(error); return; }
                    try {
                        imageInfo(body);
                        atomicWrite(backgroundPath, body);
                        refreshBackground();
                        if (!settings.wallpaperEnabled || settings.wallpaperMode !== "image") {
                            var updated = JSON.parse(JSON.stringify(settings));
                            updated.wallpaperEnabled = true;
                            updated.wallpaperMode = "image";
                            atomicWrite(configPath, JSON.stringify(updated) + "\n");
                            settings = updated;
                        }
                        send(200, JSON.stringify(state()));
                    } catch (uploadError) { fail(uploadError); }
                });
            } else if (parsed.pathname === "/api/live-background") {
                if (videoUploadBusy) throw problem(409, "Another MP4 upload is in progress.");
                if ((request.headers["content-type"] || "").split(";")[0] !== "video/mp4") {
                    throw problem(415, "Upload an H.264 MP4 video.");
                }
                videoUploadBusy = true;
                video.receive(request, videoPath, function (error, info) {
                    videoUploadBusy = false;
                    if (error) { fail(error); return; }
                    videoBackground = info;
                    try {
                        var updated = JSON.parse(JSON.stringify(settings));
                        updated.wallpaperEnabled = true;
                        updated.wallpaperMode = "video";
                        atomicWrite(configPath, JSON.stringify(updated) + "\n");
                        settings = updated;
                        send(200, JSON.stringify(state()));
                    } catch (saveError) { fail(saveError); }
                });
            } else {
                throw problem(404, "Not found.");
            }
        } catch (error) { fail(error); }
    });
    server.timeout = 20000;
    var weatherTimer = setInterval(refreshWeather, 10 * 60 * 1000);
    weatherTimer.unref();
    server.on("close", function () {
        clearInterval(weatherTimer);
        weatherGeneration++;
        if (wake) wake.close();
        if (picture) picture.close();
        if (idle) idle.close();
    });
    server.restorePictureContext = function (callback) {
        function restorePicture(idleError) {
            if (picture) picture.close(function (pictureError) { callback(idleError || pictureError); });
            else callback(idleError);
        }
        if (idle) idle.close(restorePicture);
        else restorePicture();
    };
    refreshWeather();
    return server;
}

module.exports = {createApp: createApp, validateSettings: validateSettings, imageInfo: imageInfo};

if (require.main === module) {
    var port = Number(process.env.HOME_CUSTOM_PORT || 80);
    if (!isFinite(port) || port < 1 || port > 65535 || port % 1 !== 0) {
        throw new Error("Invalid HOME_CUSTOM_PORT.");
    }
    var app = createApp({manageWake: true, managePicture: true, manageIdle: true});
    app.on("error", function (error) {
        console.error("Home settings server failed: " + error.stack);
        process.exit(1);
    });
    app.listen(port, "0.0.0.0", function () {
        console.log("Home settings listening on port " + port);
    });
    process.on("SIGTERM", function () {
        app.close(function () {
            app.restorePictureContext(function (error) {
                if (error) console.error("Home picture restoration failed: " + error.message);
                process.exit(error ? 1 : 0);
            });
        });
        setTimeout(function () {
            console.error("Home settings shutdown timed out; restoration journal retained.");
            process.exit(1);
        }, 10000).unref();
    });
}
