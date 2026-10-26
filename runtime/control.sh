#!/bin/sh
set -eu
PATH=/sbin:/usr/sbin:/bin:/usr/bin
export PATH
unset LD_PRELOAD

BASE=/var/lib/webosbrew/b9-home-custom
ROOT=/usr/palm/applications/com.webos.app.fullhome/qml/UserInterfaceLayer
HOOK=/var/lib/webosbrew/init.d/30-b9-home-custom
ACTIVITY=org.webosbrew.b9homecustom.startup

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

rpc() {
    reply="$(luna-send -m com.webos.lunasend-homecustom -n 1 -w 5000 -f "$1" "$2")"
    printf '%s\n' "$reply"
    printf '%s\n' "$reply" |
        grep -q '"returnValue"[[:space:]]*:[[:space:]]*true' ||
        fail "Request failed: $1"
}

mounted() {
    awk -v target="$1" '$2 == target { found = 1 } END { exit !found }' /proc/mounts
}

paths() {
    printf '%s\n' Containers/Main/TopShelf.qml Containers/Main/MainRibbon.qml Containers/MainView.qml GlobalStyle.qml Model/ShelfList.js main.qml SystemSaverMainView.qml
}

file_target() {
    case "$1" in
        main.qml) printf '%s\n' "${ROOT%/*}/main.qml" ;;
        SystemSaverMainView.qml) printf '%s\n' /usr/palm/applications/com.webos.app.screensaver/qml/Containers/MainView.qml ;;
        YSM.qml) printf '%s\n' /usr/lib/qt5/qml/YSM/YSM.qml ;;
        Model/*) printf '%s\n' "${ROOT%/*}/$1" ;;
        *) printf '%s\n' "$ROOT/$1" ;;
    esac
}

snapshot_paths() {
    printf '%s\n' /tmp/checkpoint/com.webos.app.fullhome \
        /mnt/lg/cmn_data/checkpoint/com.webos.app.fullhome \
        /tmp/checkpoint/com.webos.app.screensaver \
        /mnt/lg/cmn_data/checkpoint/com.webos.app.screensaver
}

snapshot_blocked() {
    awk -v target="$1" '$1 == "b9-home-custom" && $2 == target &&
        $3 == "tmpfs" && $4 ~ /(^|,)ro(,|$)/ { found = 1 }
        END { exit !found }' /proc/mounts
}

block_home_snapshot() {
    snapshot_paths | while IFS= read -r directory; do
        if mounted "$directory"; then
            snapshot_blocked "$directory" ||
                fail "Another mount controls Home snapshots: $directory"
        else
            mkdir -p "$directory"
            mount -t tmpfs -o ro,size=4096 b9-home-custom "$directory"
        fi
    done
}

verify() {
    paths | while IFS= read -r path; do
        target="$(file_target "$path")"
        mounted "$target" || fail "Missing Home overlay: $path"
        cmp -s "$BASE/patched/$path" "$target" ||
            fail "Unexpected Home overlay contents: $path"
    done
    snapshot_paths | while IFS= read -r directory; do
        snapshot_blocked "$directory" || fail "Home snapshot bypass missing: $directory"
        [ -z "$(ls -A "$directory")" ] || fail "Home snapshot bypass is not empty"
    done
    echo "HOME_OVERLAYS_OK boot=$(cat /proc/sys/kernel/random/boot_id)"
}

apply() {
    [ -f "$BASE/patched/DvdAnimation.qml" ] || fail "DVD animation component is missing"
    [ -f "$BASE/patched/LiveWallpaper.qml" ] || fail "Live wallpaper component is missing"
    [ -f "$BASE/patched/dvd-logo.png" ] || fail "DVD logo is missing"
    paths | while IFS= read -r path; do
        target="$(file_target "$path")"
        [ -f "$BASE/patched/$path" ] || fail "Missing patched file: $path"
        if mounted "$target"; then
            cmp -s "$BASE/patched/$path" "$target" ||
                fail "Another overlay controls $path"
        else
            cmp -s "$BASE/original/$path" "$target" ||
                fail "Original Home file changed: $path"
            mount --bind "$BASE/patched/$path" "$target"
        fi
    done
    block_home_snapshot
    verify
}

unmount_ours() {
    paths | while IFS= read -r path; do
        target="$(file_target "$path")"
        if mounted "$target"; then
            cmp -s "$BASE/patched/$path" "$target" ||
                fail "Refusing to unmount another owner's overlay: $path"
            umount "$target"
        fi
    done
    snapshot_paths | while IFS= read -r directory; do
        if mounted "$directory"; then
            snapshot_blocked "$directory" ||
                fail "Refusing to unmount another owner's snapshot overlay"
            umount "$directory"
        fi
    done
}

home_pids() {
    for file in /proc/[0-9]*/exe; do
        executable="$(readlink "$file" 2>/dev/null)" || continue
        if [ "$executable" = /usr/bin/com.webos.app.fullhome ]; then
            pid="${file#/proc/}"
            printf '%s\n' "${pid%/exe}"
        fi
    done
}

home_running() {
    [ -n "$(home_pids)" ]
}

launch_home() {
    rpc luna://com.webos.applicationManager/launch \
        '{"id":"com.webos.app.fullhome","params":{"launchType":"homeKey"}}'
}

web_running() {
    [ -f "$BASE/web/server.pid" ] || return 1
    web_pid="$(cat "$BASE/web/server.pid")"
    case "$web_pid" in ""|*[!0-9]*) return 1 ;; esac
    [ -r "/proc/$web_pid/cmdline" ] || return 1
    [ "$(readlink "/proc/$web_pid/exe")" = /usr/bin/node ] || return 1
    [ "$(tr '\000' '\n' < "/proc/$web_pid/cmdline" | sed -n '2p')" = "$BASE/web/server.js" ]
}

web_ready() {
    web_reply="$(curl -fsS --max-time 2 http://127.0.0.1/api/health)" || return 1
    printf '%s\n' "$web_reply" |
        node -e 'var s="";process.stdin.on("data",function(d){s+=d;});process.stdin.on("end",function(){var v=JSON.parse(s);if(v.service!=="native-home-settings"||v.ready!==true)process.exit(1);});'
}

start_web() {
    [ -f "$BASE/web/server.js" ] || fail "Home settings server is missing"
    if ! web_running; then
        node -e 'var f=require("fs"),c=require("child_process"),b=process.argv[1],fd=f.openSync(b+"/web/server.log","a"),p=c.spawn("/usr/bin/node",[b+"/web/server.js"],{detached:true,stdio:["ignore",fd,fd]});p.on("error",function(e){throw e;});p.unref();f.closeSync(fd);f.writeFileSync(b+"/web/server.pid",String(p.pid)+"\n");' "$BASE"
    fi
    web_attempt=1
    while [ "$web_attempt" -le 10 ]; do
        if web_running && web_ready; then
            echo "HOME_SETTINGS_READY"
            return
        fi
        sleep 1
        web_attempt=$((web_attempt + 1))
    done
    tail -n 12 "$BASE/web/server.log" >&2
    fail "Home settings server did not become ready"
}

stop_web() {
    if web_running; then
        kill -TERM "$web_pid"
        web_attempt=1
        while web_running && [ "$web_attempt" -le 10 ]; do
            sleep 1
            web_attempt=$((web_attempt + 1))
        done
        if web_running; then fail "Home settings server did not stop"; fi
    fi
}

log_boot_stage() {
    read stage_uptime stage_idle < /proc/uptime
    printf 'HOME_BOOT_STAGE stage=%s uptime=%s\n' "$1" "$stage_uptime"
}

ensure_idle_policy() {
    target="$(file_target YSM.qml)"
    if mounted "$target"; then
        cmp -s "$BASE/patched/YSM.qml" "$target" ||
            fail "Another overlay controls the retired Home idle policy"
        umount "$target"
    fi
    cmp -s "$BASE/original/YSM.qml" "$target" ||
        fail "Original window-manager policy changed"
    echo "HOME_IDLE_POLICY_RUNTIME"
}

activate() {
    previous_home_pids="$(home_pids)"
    if [ -n "$previous_home_pids" ]; then
        rpc luna://com.webos.applicationManager/closeByAppId \
            '{"id":"com.webos.app.fullhome"}'
        for pid in $previous_home_pids; do
            if [ "$(readlink "/proc/$pid/exe" 2>/dev/null)" = /usr/bin/com.webos.app.fullhome ]; then
                kill -TERM "$pid" || {
                    [ ! -e "/proc/$pid/exe" ] || fail "Could not stop original Home process $pid"
                }
            fi
        done
        sleep 1
        for pid in $previous_home_pids; do
            if [ "$(readlink "/proc/$pid/exe" 2>/dev/null)" = /usr/bin/com.webos.app.fullhome ]; then
                kill -KILL "$pid" || {
                    [ ! -e "/proc/$pid/exe" ] || fail "Could not finish stopping original Home process $pid"
                }
            fi
        done
        sleep 1
    fi
    log_boot_stage home-launch-request
    launch_home
    attempt=1
    stable=0
    while [ "$attempt" -le 30 ]; do
        if home_running; then
            stable=$((stable + 1))
            [ "$stable" -lt 3 ] || break
        else
            stable=0
        fi
        echo "Waiting for Home process ($attempt/30)" >&2
        sleep 1
        attempt=$((attempt + 1))
    done
    if [ "$stable" -lt 3 ] || ! home_running; then
        echo "ERROR: Customized Home did not remain running within 30 seconds; restoring original Home" >&2
        unmount_ours
        launch_home
        exit 1
    fi
    log_boot_stage home-process-stable
    echo "CUSTOM_HOME_RUNNING"
}

boot() {
    log_boot_stage root-hook-started
    apply
    log_boot_stage overlays-ready
    start_web
    log_boot_stage settings-ready
    ensure_idle_policy
    boot_id="$(cat /proc/sys/kernel/random/boot_id)"
    if [ ! -f "$BASE/activated-boot" ] ||
        [ "$(cat "$BASE/activated-boot")" != "$boot_id" ]; then
        activate
        printf '%s\n' "$boot_id" > "$BASE/activated-boot"
        sync
    fi
}

rollback() {
    if [ -f "$BASE/activity.registered" ]; then
        rpc luna://com.palm.activitymanager/cancel \
            "{\"activityName\":\"$ACTIVITY\"}"
        mv "$BASE/activity.registered" "$BASE/activity.cancelled.$(date +%s)"
    fi
    if [ -L "$HOOK" ]; then
        [ "$(readlink "$HOOK")" = "$BASE/boot.sh" ] ||
            fail "Refusing to change another owner's startup hook"
        mv "$HOOK" "$BASE/hook.disabled.$(date +%s)"
    fi
    stop_web
    unmount_ours
    if [ -f "$BASE/boot-policy.backup.json" ]; then
        node "$BASE/web/boot-policy.js" rollback
    fi
    rpc luna://com.webos.settingsservice/setSystemSettings \
        "$(cat "$BASE/settings.restore.json")"
    if [ -f "$BASE/settings.option.restore.json" ]; then
        rpc luna://com.webos.settingsservice/setSystemSettings \
            "$(cat "$BASE/settings.option.restore.json")"
    fi
    if [ -f "$BASE/settings.idle.restore.json" ]; then
        rpc luna://com.webos.settingsservice/setSystemSettings \
            "$(cat "$BASE/settings.idle.restore.json")"
    fi
    activate
    echo "HOME_ROLLBACK_OK"
}

exec 9>"$BASE/control.lock"
flock -x 9
[ "$(id -u)" = 0 ] || fail "Root is required"
case "${1:-}" in
    apply) start_web; apply ;;
    activate) start_web; apply; activate ;;
    boot) boot ;;
    verify) verify; web_running || fail "Home settings process missing"; web_ready || fail "Home settings server unavailable" ;;
    web-start) start_web ;;
    web-stop) stop_web ;;
    rollback) rollback ;;
    *) fail "Usage: $0 apply|activate|boot|verify|web-start|web-stop|rollback" ;;
esac
