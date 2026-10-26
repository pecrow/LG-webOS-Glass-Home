"use strict";

(function () {
    function placement(sourceWidth, sourceHeight, targetWidth, targetHeight, mode) {
        [sourceWidth, sourceHeight, targetWidth, targetHeight].forEach(function (value) {
            if (typeof value !== "number" || !isFinite(value) || value <= 0) {
                throw new Error("The image or TV dimensions are invalid.");
            }
        });
        if (mode !== "fit" && mode !== "crop") throw new Error("Choose Fit or Crop.");
        if (mode === "fit") return {x: 0, y: 0, width: targetWidth, height: targetHeight};
        var ratio = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
        var width = sourceWidth * ratio;
        var height = sourceHeight * ratio;
        return {
            x: (targetWidth - width) / 2, y: (targetHeight - height) / 2,
            width: width, height: height
        };
    }

    function prepare(file, display, mode) {
        return new Promise(function (resolve, reject) {
            var image = new Image();
            var canvas;
            var objectURL = URL.createObjectURL(file);
            function finish(error, blob) {
                URL.revokeObjectURL(objectURL);
                image.onload = null;
                image.onerror = null;
                image.src = "";
                if (canvas) { canvas.width = 1; canvas.height = 1; }
                if (error) reject(error);
                else if (!blob || !blob.size) reject(new Error("The browser could not encode this image."));
                else resolve(blob);
            }
            image.onerror = function () {
                finish(new Error("The browser cannot decode this image. Try a JPEG, PNG, or WebP."));
            };
            image.onload = function () {
                try {
                    var area = placement(image.naturalWidth, image.naturalHeight,
                        display.width, display.height, mode);
                    canvas = document.createElement("canvas");
                    canvas.width = display.width;
                    canvas.height = display.height;
                    var context = canvas.getContext("2d");
                    if (!context) throw new Error("The browser could not create the image canvas.");
                    context.fillStyle = "#000000";
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.imageSmoothingEnabled = true;
                    context.imageSmoothingQuality = "high";
                    context.drawImage(image, area.x, area.y, area.width, area.height);
                    canvas.toBlob(function (blob) { finish(null, blob); }, "image/jpeg", 0.92);
                } catch (error) { finish(error); }
            };
            image.src = objectURL;
        });
    }

    var api = {placement: placement, prepare: prepare};
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else window.HomeImage = api;
})();
