import QtQuick 2.6

Item {
    id: root
    property bool playing: false
    property string appId: rootWindow.appId
    property var fontManager: ({museoSans_Medium: {family: "", weight: Font.Medium},
                               emptyString: "", isRTLLocale: false})
    property var stringSheet: ({screensaver_2: "", aPlus_487: ""})
    signal failed(string message)

    onPlayingChanged: {
        if (playing) nativeFonts.active = true;
        else stopAnimation();
    }
    Component.onDestruction: stopAnimation()

    function stopAnimation() {
        animation.active = false;
        nativeStrings.active = false;
        nativeFonts.active = false;
    }

    function refreshFonts() {
        if (!nativeFonts.item) return;
        var fonts = nativeFonts.item;
        fontManager = {museoSans_Medium: {family: fonts.museoSans_Medium.family,
                                        weight: fonts.museoSans_Medium.weight},
                       emptyString: fonts.emptyString, isRTLLocale: fonts.isRTLLocale};
    }

    function refreshText() {
        if (!nativeStrings.item) return;
        stringSheet = {screensaver_2: nativeStrings.item.screensaver_2,
                       aPlus_487: nativeStrings.item.aPlus_487};
    }

    Rectangle { anchors.fill: parent; color: "#000000" }

    Loader {
        id: nativeFonts
        property var rootWindow: root
        active: false
        source: "file:///usr/palm/applications/com.webos.app.screensaver/qml/Utilities/FontManager.qml"
        onLoaded: {
            root.refreshFonts();
            item.startLocaleService();
            nativeStrings.active = root.playing;
        }
        onStatusChanged: {
            if (status === Loader.Error) root.failed("Unable to load LG screensaver fonts.");
        }
        Connections {
            target: nativeFonts.item
            onEmptyStringChanged: root.refreshFonts()
            onFontStyleChanged: root.refreshFonts()
            onIsRTLLocaleChanged: root.refreshFonts()
        }
    }

    Loader {
        id: nativeStrings
        property var rootWindow: root
        property var fontManager: root.fontManager
        active: false
        source: "file:///usr/palm/applications/com.webos.app.screensaver/qml/AppInitializer/StringSheet.qml"
        onLoaded: {
            root.refreshText();
            animation.active = root.playing;
        }
        onStatusChanged: {
            if (status === Loader.Error) root.failed("Unable to load LG screensaver text.");
        }
        Connections {
            target: nativeStrings.item
            onScreensaver_2Changed: root.refreshText()
            onAPlus_487Changed: root.refreshText()
        }
    }

    Loader {
        id: animation
        property var fontManager: root.fontManager
        property var stringSheet: root.stringSheet
        width: Math.min(parent.width, 600 * parent.width / 1920)
        height: Math.min(parent.height, 600 * parent.height / 1080)
        active: false
        source: "file:///usr/palm/applications/com.webos.app.screensaver/qml/Containers/ScreenSaver.qml"

        function restart() {
            if (!item) return;
            item.playing = false;
            x = Math.random() * Math.max(0, root.width - width);
            y = Math.random() * Math.max(0, root.height - height);
            item.playing = root.playing;
        }

        onLoaded: {
            item.liteMode = root.width <= 1280;
            item.isPartial = false;
            restart();
            console.log("Home screensaver: native LG fireworks loaded.");
        }
        onStatusChanged: {
            if (status === Loader.Error) root.failed("Unable to load the TV's LG fireworks animation.");
        }
        Connections {
            target: animation.item
            onLooped: animation.restart()
        }
    }
}
