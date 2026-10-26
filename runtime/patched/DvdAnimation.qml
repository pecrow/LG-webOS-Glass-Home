import QtQuick 2.6
import QtGraphicalEffects 1.0

Item {
    id: root

    property bool playing: false
    property real scaleFactor: Math.min(width / 1920, height / 1080)
    property double lastStep: 0
    property real velocityX: 115
    property real velocityY: 83
    property int colorIndex: 0
    property var colors: ["#ffff00", "#35d6ff", "#ff55ba", "#77ed71", "#b28aff", "#ff894f"]
    signal failed(string message)

    onPlayingChanged: {
        if (playing) restart();
    }
    onVisibleChanged: {
        if (visible && playing) restart();
    }

    function restart() {
        lastStep = Date.now();
        dvdLogo.x = width * 0.23;
        dvdLogo.y = height * 0.31;
        velocityX = 115 * scaleFactor;
        velocityY = 83 * scaleFactor;
        colorIndex = 0;
    }

    Rectangle { anchors.fill: parent; color: "#000000" }

    Item {
        id: dvdLogo
        width: 220 * root.scaleFactor
        height: width * 125 / 207

        Image {
            id: dvdLogoImage
            anchors.fill: parent
            source: "file:///var/lib/webosbrew/b9-home-custom/patched/dvd-logo.png"
            fillMode: Image.PreserveAspectFit
            smooth: true
            visible: false
            onStatusChanged: {
                if (status === Image.Error) root.failed("Unable to load the DVD logo.");
            }
        }

        ColorOverlay {
            anchors.fill: dvdLogoImage
            source: dvdLogoImage
            color: root.colors[root.colorIndex]
            cached: true
        }
    }

    Timer {
        interval: 33
        repeat: true
        running: root.playing && root.visible
        onTriggered: {
            var now = Date.now();
            var elapsed = Math.min((now - root.lastStep) / 1000, 0.1);
            root.lastStep = now;
            var maxX = Math.max(0, root.width - dvdLogo.width);
            var maxY = Math.max(0, root.height - dvdLogo.height);
            var x = dvdLogo.x + root.velocityX * elapsed;
            var y = dvdLogo.y + root.velocityY * elapsed;
            var bounced = false;
            if (x <= 0 || x >= maxX) { root.velocityX *= -1; bounced = true; }
            if (y <= 0 || y >= maxY) { root.velocityY *= -1; bounced = true; }
            dvdLogo.x = Math.max(0, Math.min(maxX, x));
            dvdLogo.y = Math.max(0, Math.min(maxY, y));
            if (bounced) root.colorIndex = (root.colorIndex + 1) % root.colors.length;
        }
    }
}
