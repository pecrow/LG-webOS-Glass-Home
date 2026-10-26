"use strict";

var fs = require("fs");
var sequence = 0;
var MAX_VIDEO = 150 * 1024 * 1024;
var MAX_METADATA = 8 * 1024 * 1024;

function problem(status, message) {
    var error = new Error(message);
    error.status = status;
    return error;
}

function integer64(buffer, offset) {
    var value = buffer.readUInt32BE(offset) * 4294967296 + buffer.readUInt32BE(offset + 4);
    if (value > 9007199254740991) throw problem(415, "MP4 contains an unsupported box size or duration.");
    return value;
}

function boxes(buffer, start, end) {
    var result = [];
    while (start < end) {
        if (result.length >= 4096) throw problem(415, "MP4 contains too many metadata boxes.");
        if (end - start < 8) throw problem(415, "Truncated MP4 metadata.");
        var size = buffer.readUInt32BE(start);
        var header = 8;
        if (size === 1) {
            if (end - start < 16) throw problem(415, "Truncated MP4 box.");
            size = integer64(buffer, start + 8);
            header = 16;
        } else if (size === 0) size = end - start;
        if (size < header || size > end - start) throw problem(415, "Invalid MP4 box size.");
        result.push({type: buffer.toString("ascii", start + 4, start + 8),
            start: start + header, end: start + size});
        start += size;
    }
    return result;
}

function child(buffer, parent, type) {
    var matches = boxes(buffer, parent.start, parent.end).filter(function (box) {
        return box.type === type;
    });
    if (matches.length !== 1) throw problem(415, "Missing or repeated MP4 " + type + " metadata.");
    return matches[0];
}

function requireBytes(box, count) {
    if (box.end - box.start < count) throw problem(415, "Incomplete MP4 " + box.type + " metadata.");
}

function read(descriptor, length, position) {
    var buffer = new Buffer(length);
    var offset = 0;
    while (offset < length) {
        var count = fs.readSync(descriptor, buffer, offset, length - offset, position + offset);
        if (!count) throw problem(415, "Truncated MP4 file.");
        offset += count;
    }
    return buffer;
}

function info(filename) {
    var descriptor = fs.openSync(filename, "r");
    try {
        var stat = fs.fstatSync(descriptor);
        if (!stat.size || stat.size > MAX_VIDEO) throw problem(413, "MP4 wallpapers must be at most 150 MB.");
        var offset = 0;
        var metadata;
        var hasType = false;
        var hasMedia = false;
        while (offset < stat.size) {
            if (stat.size - offset < 8) throw problem(415, "Truncated MP4 file.");
            var header = read(descriptor, Math.min(16, stat.size - offset), offset);
            var size = header.readUInt32BE(0);
            var type = header.toString("ascii", 4, 8);
            var headerSize = size === 1 ? 16 : 8;
            if (size === 1) {
                if (header.length < 16) throw problem(415, "Truncated MP4 box.");
                size = integer64(header, 8);
            } else if (!size) size = stat.size - offset;
            if (size < headerSize || size > stat.size - offset) throw problem(415, "Invalid MP4 file.");
            if (type === "ftyp") {
                if (hasType || size < headerSize + 8) throw problem(415, "Invalid MP4 file type.");
                hasType = true;
            } else if (type === "mdat") hasMedia = hasMedia || size > headerSize;
            else if (type === "moov") {
                if (metadata || size > MAX_METADATA) throw problem(415, "MP4 metadata is too large or repeated.");
                metadata = read(descriptor, size - headerSize, offset + headerSize);
            } else if (type === "moof") throw problem(415, "Use a regular MP4, not a fragmented streaming MP4.");
            offset += size;
        }
        if (!hasType || !hasMedia || !metadata) throw problem(415, "Upload a complete H.264 MP4 video.");
        var tracks = boxes(metadata, 0, metadata.length).filter(function (box) { return box.type === "trak"; });
        var videos = [];
        tracks.forEach(function (track) {
            var media = child(metadata, track, "mdia");
            var handler = child(metadata, media, "hdlr");
            requireBytes(handler, 12);
            if (metadata.toString("ascii", handler.start + 8, handler.start + 12) !== "vide") return;
            var timing = child(metadata, media, "mdhd");
            requireBytes(timing, 20);
            var version = metadata[timing.start];
            if (version > 1) throw problem(415, "Unsupported MP4 timing version.");
            requireBytes(timing, version ? 32 : 20);
            var scale = metadata.readUInt32BE(timing.start + (version ? 20 : 12));
            var duration = version ? integer64(metadata, timing.start + 24) :
                metadata.readUInt32BE(timing.start + 16);
            if (!scale || !duration) throw problem(415, "MP4 has an invalid duration.");
            var table = child(metadata, child(metadata, media, "minf"), "stbl");
            var description = child(metadata, table, "stsd");
            requireBytes(description, 8);
            var entries = boxes(metadata, description.start + 8, description.end);
            if (entries.length !== 1 || metadata.readUInt32BE(description.start + 4) !== 1 ||
                    entries[0].type !== "avc1") {
                throw problem(415, "Use an H.264 (AVC) MP4 video.");
            }
            var video = entries[0];
            requireBytes(video, 78);
            var width = metadata.readUInt16BE(video.start + 24);
            var height = metadata.readUInt16BE(video.start + 26);
            if (!width || !height || width > 3840 || height > 2160) {
                throw problem(415, "Use an MP4 at 3840 x 2160 (4K) or smaller for Home.");
            }
            var configuration = child(metadata, {start: video.start + 78, end: video.end}, "avcC");
            requireBytes(configuration, 7);
            if (metadata[configuration.start] !== 1 ||
                    [66, 77, 100].indexOf(metadata[configuration.start + 1]) === -1) {
                throw problem(415, "Use an 8-bit H.264 Baseline, Main, or High profile MP4.");
            }
            var samples = child(metadata, table, "stts");
            requireBytes(samples, 8);
            var count = metadata.readUInt32BE(samples.start + 4);
            if (!count || count > (samples.end - samples.start - 8) / 8) {
                throw problem(415, "Invalid MP4 frame timing.");
            }
            var frames = 0;
            var ticks = 0;
            for (var index = 0; index < count; index++) {
                var sampleCount = metadata.readUInt32BE(samples.start + 8 + index * 8);
                var sampleTicks = metadata.readUInt32BE(samples.start + 12 + index * 8);
                if (!sampleCount || !sampleTicks || scale / sampleTicks > 60.01) {
                    throw problem(415, "Use a video at 60 frames per second or lower.");
                }
                frames += sampleCount;
                ticks += sampleCount * sampleTicks;
            }
            videos.push({mime: "video/mp4", width: width, height: height,
                duration: duration / scale, fps: Math.round(frames * scale / ticks * 100) / 100});
        });
        if (videos.length !== 1) throw problem(415, "Use an MP4 containing exactly one video track.");
        var result = videos[0];
        result.version = String(stat.mtime.getTime()) + "-" + stat.size;
        result.size = stat.size;
        return result;
    } finally {
        fs.closeSync(descriptor);
    }
}

function receive(request, filename, callback) {
    var descriptor;
    var temporary = filename + "." + process.pid + "." + (++sequence) + ".tmp";
    try {
        var length = request.headers["content-length"];
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_VIDEO)) {
            throw problem(413, "MP4 wallpapers must be at most 150 MB.");
        }
        descriptor = fs.openSync(temporary, "wx", 384);
    } catch (error) { callback(error); return; }
    var total = 0;
    var writing = false;
    var ended = false;
    var finished = false;
    var pendingError;
    function finish(error) {
        if (finished) return;
        if (writing) { pendingError = error; return; }
        finished = true;
        var result;
        try {
            if (!error) fs.fsyncSync(descriptor);
        } catch (syncError) { error = syncError; }
        try { fs.closeSync(descriptor); }
        catch (closeError) { error = error || closeError; }
        if (!error) {
            try {
                result = info(temporary);
                fs.renameSync(temporary, filename);
            } catch (saveError) { error = saveError; }
        }
        if (error) {
            try { fs.unlinkSync(temporary); }
            catch (cleanupError) { console.error("Unable to remove incomplete MP4 upload: " + cleanupError.message); }
        }
        request.resume();
        callback(error, result);
    }
    request.on("data", function (chunk) {
        if (finished || pendingError) return;
        total += chunk.length;
        if (total > MAX_VIDEO) { finish(problem(413, "MP4 wallpapers must be at most 150 MB.")); return; }
        request.pause();
        writing = true;
        function write(offset) {
            fs.write(descriptor, chunk, offset, chunk.length - offset, null, function (error, count) {
                if (error || !count || pendingError) {
                    writing = false;
                    finish(error || pendingError || new Error("Unable to write the MP4 upload."));
                } else if (offset + count < chunk.length) write(offset + count);
                else {
                    writing = false;
                    if (ended) finish(pendingError);
                    else request.resume();
                }
            });
        }
        write(0);
    });
    request.on("end", function () {
        ended = true;
        if (!writing) finish(pendingError);
    });
    request.on("aborted", function () { finish(problem(400, "MP4 upload was interrupted.")); });
    request.on("error", finish);
}

function serve(request, response, filename) {
    var descriptor = fs.openSync(filename, "r");
    try {
        var size = fs.fstatSync(descriptor).size;
        var start = 0;
        var end = size - 1;
        var range = request.headers.range;
        var match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
            if (!match[1]) start = Math.max(0, size - Number(match[2]));
            else {
                start = Number(match[1]);
                if (match[2]) end = Math.min(end, Number(match[2]));
            }
        }
        if (range && (!match || (!match[1] && !match[2]) ||
                start > end || start < 0 || end >= size)) {
            response.writeHead(416, {"Content-Range": "bytes */" + size, "Content-Length": 0});
            response.end();
            return;
        }
        var headers = {"Content-Type": "video/mp4", "Content-Length": end - start + 1,
            "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"};
        if (range) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
        if (request.method === "HEAD") {
            response.writeHead(range ? 206 : 200, headers);
            response.end();
            return;
        }
        var stream = fs.createReadStream(filename, {fd: descriptor, start: start, end: end});
        descriptor = null;
        stream.on("error", function (error) {
            console.error("Unable to stream live wallpaper: " + error.message);
            response.destroy();
        });
        response.on("close", function () { stream.destroy(); });
        response.writeHead(range ? 206 : 200, headers);
        stream.pipe(response);
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
    }
}

module.exports = {info: info, receive: receive, serve: serve, maximum: MAX_VIDEO};
