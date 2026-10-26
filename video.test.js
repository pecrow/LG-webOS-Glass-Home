"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {Readable} = require("node:stream");
const vm = require("node:vm");
const runtime = path.resolve(process.argv[2] || path.join(__dirname, "runtime"));
const video = require(path.join(runtime, "web", "video.js"));
const maximum = 150 * 1024 * 1024;

function mp4(width = 3840, height = 2160, fps = 60, codec = "avc1") {
    function box(type, ...parts) {
        const body = Buffer.concat(parts);
        const header = Buffer.alloc(8);
        header.writeUInt32BE(body.length + 8);
        header.write(type, 4);
        return Buffer.concat([header, body]);
    }
    const timing = Buffer.alloc(24);
    timing.writeUInt32BE(90000, 12);
    timing.writeUInt32BE(270000, 16);
    const handler = Buffer.alloc(12);
    handler.write("vide", 8);
    const visual = Buffer.alloc(78);
    visual.writeUInt16BE(width, 24);
    visual.writeUInt16BE(height, 26);
    const description = Buffer.alloc(8);
    description.writeUInt32BE(1, 4);
    const samples = Buffer.alloc(16);
    samples.writeUInt32BE(1, 4);
    samples.writeUInt32BE(fps * 3, 8);
    samples.writeUInt32BE(90000 / fps, 12);
    return Buffer.concat([
        box("ftyp", Buffer.from("isom0000isom")),
        box("moov", box("trak", box("mdia", box("hdlr", handler), box("mdhd", timing),
            box("minf", box("stbl", box("stsd", description,
                box(codec, visual, box("avcC", Buffer.from([1, 100, 0, 51, 255, 225, 0])))),
            box("stts", samples)))))),
        box("mdat", Buffer.from("metadata-test-fixture"))
    ]);
}

function padded(size) {
    const prefix = mp4();
    const offset = prefix.lastIndexOf("mdat") - 4;
    prefix.writeUInt32BE(size - offset, offset);
    const zeros = Buffer.alloc(1024 * 1024);
    return Readable.from((function* () {
        yield prefix;
        for (let remaining = size - prefix.length; remaining > 0; remaining -= zeros.length) {
            yield zeros.subarray(0, Math.min(remaining, zeros.length));
        }
    })(), {objectMode: false});
}

function receive(request, filename, headers = {}) {
    request.headers = headers;
    return new Promise(resolve => {
        video.receive(request, filename, (error, info) => resolve({error, info}));
    });
}

function checkLooping(qml) {
    assert.match(qml, /id: loopTimer\s+interval: 16/);
    function handler(name) {
        const match = qml.match(new RegExp(name + ": \\{([\\s\\S]*?)\\n        \\}"));
        assert.ok(match, "Missing QML handler: " + name);
        return match[1];
    }
    const loop = qml.match(/id: loopTimer[\s\S]*?onTriggered: \{([\s\S]*?)\n        \}/);
    assert.ok(loop);
    const restart = "(function () {" + loop[1] + "\n})()";
    const commands = [];
    let restarts = 0;
    let started = 0;
    const context = {
        root: {
            playing: true, closing: false, profileRequested: false,
            lastPosition: 19000, unchangedChecks: 5, recoveries: 1,
            playbackStarted() { started++; }
        },
        player: {
            source: "file:///wallpaper.mp4",
            stop() { commands.push("stop"); },
            play() { commands.push("play"); }
        },
        loopTimer: {restart() { restarts++; }},
        MediaPlayer: {PlayingState: 1, PausedState: 2, EndOfMedia: 7},
        console: {log() {}},
        playbackState: 1, status: 3, position: 0, duration: 19366
    };
    const stateChanged = handler("onPlaybackStateChanged");
    vm.runInNewContext(stateChanged, context);
    assert.equal(started, 1);
    assert.equal(restarts, 0);
    context.status = 7;
    vm.runInNewContext(handler("onStatusChanged"), context);
    assert.equal(restarts, 1);

    // LG leaves EndOfMedia latched, but still reports PausedState at each later end.
    for (let cycle = 0; cycle < 4; cycle++) {
        context.playbackState = 2;
        vm.runInNewContext(stateChanged, context);
        assert.equal(restarts, cycle + 2);
        vm.runInNewContext(restart, context);
        assert.deepEqual(commands.slice(-2), ["stop", "play"]);
        assert.equal(context.player.source, "file:///wallpaper.mp4");
        assert.equal(context.root.lastPosition, -1);
        assert.equal(context.root.unchangedChecks, 0);
        assert.equal(context.root.recoveries, 1);
        context.playbackState = 1;
        vm.runInNewContext(stateChanged, context);
        assert.equal(restarts, cycle + 2);
    }
    assert.equal(started, 1);
    context.playbackState = 2;
    context.status = 3;
    vm.runInNewContext(stateChanged, context);
    assert.equal(restarts, 5);
    context.status = 7;
    context.root.playing = false;
    vm.runInNewContext(stateChanged, context);
    vm.runInNewContext(restart, context);
    context.root.playing = true;
    context.root.closing = true;
    vm.runInNewContext(restart, context);
    context.root.closing = false;
    context.player.source = "";
    vm.runInNewContext(restart, context);
    assert.equal(restarts, 5);
    assert.equal(commands.length, 8);
    assert.doesNotMatch(qml, /player\.seek\(0\)/);
    assert.match(qml, /function resetPlayback[\s\S]*?loopTimer\.stop\(\)/);
}

function checkWallpaperLifecycle() {
    const recipe = JSON.parse(fs.readFileSync(path.join(runtime, "firmware-patches.json"), "utf8"));
    const main = recipe.files.find(entry => entry.name === "Containers/MainView.qml");
    assert.ok(main);
    const hosts = main.edits.flatMap(edit => edit.pieces)
        .filter(piece => piece.text && piece.text.includes("id: liveWallpaperLoader"));
    assert.equal(hosts.length, 1);
    const host = hosts[0].text;
    const active = host.match(/^\s*active:\s*(.+)$/m);
    assert.ok(active);
    assert.equal(active[1], "root.liveWallpaperPlaying");
    for (const playing of [false, true, false, true, false]) {
        assert.equal(vm.runInNewContext(active[1], {root: {liveWallpaperPlaying: playing}}), playing);
    }
    assert.match(host, /item\.playing = Qt\.binding\(function\(\) \{ return root\.liveWallpaperPlaying; \}\)/);
    assert.match(host, /onPlaybackStarted: root\.refreshHomeVideoPicture\(\)/);
    const player = fs.readFileSync(path.join(runtime, "patched", "LiveWallpaper.qml"), "utf8");
    const destroy = player.match(/Component\.onDestruction: \{([\s\S]*?)\n    \}/);
    assert.ok(destroy);
    const calls = [];
    const context = {closing: false, player: {source: "file:///wallpaper.mp4", stop() { calls.push("stop"); }}};
    vm.runInNewContext(destroy[1], context);
    assert.equal(context.closing, true);
    assert.equal(context.player.source, "");
    assert.deepEqual(calls, ["stop"]);
}

async function run() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glass-video-limits-"));
    const filename = path.join(directory, "wallpaper.mp4");
    try {
        const player = fs.readFileSync(path.join(runtime, "patched", "LiveWallpaper.qml"), "utf8");
        checkLooping(player);
        checkWallpaperLifecycle();
        assert.equal(video.maximum, maximum);
        for (const [width, height, fps] of [[3840, 2160, 60], [1920, 1080, 30], [1280, 720, 24]]) {
            fs.writeFileSync(filename, mp4(width, height, fps));
            const info = video.info(filename);
            assert.deepEqual([info.width, info.height, info.fps], [width, height, fps]);
        }
        for (const fixture of [mp4(3841, 2160), mp4(3840, 2161), mp4(4096, 2160),
                mp4(0, 2160), mp4(3840, 0), mp4(3840, 2160, 120), mp4(3840, 2160, 60, "hvc1")]) {
            fs.writeFileSync(filename, fixture);
            assert.throws(() => video.info(filename), error => error.status === 415);
        }

        let result = await receive(padded(maximum), filename, {"content-length": String(maximum)});
        assert.ifError(result.error);
        assert.equal(result.info.size, maximum);
        assert.equal(result.info.width, 3840);
        assert.equal(result.info.height, 2160);
        assert.equal(video.info(filename).size, maximum);
        fs.truncateSync(filename, maximum + 1);
        assert.throws(() => video.info(filename), error => error.status === 413 && /150 MB/.test(error.message));

        const original = mp4(1920, 1080, 30);
        fs.writeFileSync(filename, original);
        result = await receive(Readable.from([]), filename, {"content-length": String(maximum + 1)});
        assert.equal(result.error.status, 413);
        assert.deepEqual(fs.readFileSync(filename), original);

        result = await receive(padded(maximum + 1), filename);
        assert.equal(result.error.status, 413);
        assert.match(result.error.message, /150 MB/);
        assert.deepEqual(fs.readFileSync(filename), original);
        assert.deepEqual(fs.readdirSync(directory), ["wallpaper.mp4"]);
        console.log("PASS 4K/60 fps and exact 150 MB uploads; oversized dimensions, files and streams rejected without replacing saved video");
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
