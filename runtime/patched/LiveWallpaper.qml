import QtQuick 2.6
import QtMultimedia 5.6

Item {
    id: root
    property url source: ""
    property string revision: ""
    property bool playing: false
    property bool closing: false
    property int lastPosition: -1
    property int unchangedChecks: 0
    property int recoveries: 0
    property bool profileRequested: false
    signal playbackError(string message)
    signal playbackStarted()

    visible: playing
    onPlayingChanged: resetPlayback(true)
    onSourceChanged: resetPlayback(true)
    onRevisionChanged: resetPlayback(true)

    function resetPlayback(resetRetries) {
        startTimer.stop();
        loopTimer.stop();
        player.stop();
        player.source = "";
        lastPosition = -1;
        unchangedChecks = 0;
        profileRequested = false;
        if (resetRetries) recoveries = 0;
        if (!closing && playing && source.toString() !== "") startTimer.restart();
    }

    function recoverPlayback() {
        if (++recoveries > 2) {
            playbackError("Playback stopped progressing after two recovery attempts.");
            return;
        }
        console.warn("Live wallpaper: recovering stalled player; position=" + player.position +
                     " status=" + player.status + " state=" + player.playbackState +
                     " buffer=" + player.bufferProgress);
        resetPlayback(false);
    }

    MediaPlayer {
        id: player
        autoPlay: true
        muted: true
        volume: 0
        loops: 1
        onPlaybackStateChanged: {
            console.log("Live wallpaper: playbackState=" + playbackState +
                        " status=" + status + " position=" + position);
            // LG can keep EndOfMedia latched across later playback cycles.
            if (root.playing && playbackState === MediaPlayer.PausedState &&
                    status === MediaPlayer.EndOfMedia) loopTimer.restart();
            if (playbackState === MediaPlayer.PlayingState && root.playing && !root.profileRequested) {
                root.profileRequested = true;
                root.playbackStarted();
            }
        }
        onStatusChanged: {
            console.log("Live wallpaper: status=" + status + " state=" + playbackState +
                        " position=" + position + " duration=" + duration);
            if (root.playing && status === MediaPlayer.EndOfMedia) loopTimer.restart();
        }
        onError: {
            if (!root.closing && root.playing && source.toString() !== "" &&
                    error !== MediaPlayer.NoError)
                root.playbackError(errorString || "The TV could not play this MP4.");
        }
    }

    Timer {
        id: startTimer
        interval: 300
        onTriggered: {
            if (!root.closing && root.playing) player.source = root.source;
        }
    }

    Timer {
        id: loopTimer
        interval: 16
        onTriggered: {
            if (root.closing || !root.playing || player.source.toString() === "") return;
            console.log("Live wallpaper: restarting completed video.");
            root.lastPosition = -1;
            root.unchangedChecks = 0;
            player.stop();
            player.play();
        }
    }

    Timer {
        interval: 2000
        repeat: true
        running: root.playing && !root.closing
        onTriggered: {
            if (startTimer.running || player.source.toString() === "") return;
            if (player.position !== root.lastPosition) {
                root.lastPosition = player.position;
                root.unchangedChecks = 0;
            } else if (++root.unchangedChecks >= 6) {
                root.recoverPlayback();
            }
        }
    }

    VideoOutput {
        anchors.fill: parent
        source: player
        fillMode: VideoOutput.PreserveAspectCrop
    }

    Component.onDestruction: {
        closing = true;
        player.stop();
        player.source = "";
    }
}
