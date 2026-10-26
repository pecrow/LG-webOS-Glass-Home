"use strict";

var fs = require("fs");

module.exports = function atomicWrite(filename, data) {
    var temporary = filename + ".tmp";
    var descriptor = fs.openSync(temporary, "w", 384);
    try {
        var bytes = Buffer.isBuffer(data) ? data : new Buffer(data, "utf8");
        var written = 0;
        while (written < bytes.length) {
            var count = fs.writeSync(descriptor, bytes, written, bytes.length - written, null);
            if (count <= 0) throw new Error("Unable to complete the saved file.");
            written += count;
        }
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filename);
};
