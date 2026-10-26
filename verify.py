import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
from firmware import generated_files


APP_ID = "org.webosbrew.b9homecustom"
PACKAGE_MAINTAINER = "LG webOS Glass Home"


def ar_members(contents):
    if not contents.startswith(b"!<arch>\n"):
        raise ValueError("Invalid IPK/ar header")
    members = []
    offset = 8
    while offset < len(contents):
        header = contents[offset:offset + 60]
        if len(header) != 60 or header[58:60] != b"`\n":
            raise ValueError("Invalid ar member")
        size = int(header[48:58])
        if size < 0 or offset + 60 + size + size % 2 > len(contents):
            raise ValueError("Truncated ar member")
        name = header[:16].decode("ascii").strip().rstrip("/")
        members.append((name, header, contents[offset + 60:offset + 60 + size]))
        offset += 60 + size + size % 2
    if len({name for name, _, _ in members}) != len(members):
        raise ValueError("Duplicate ar member")
    return members


def verify_control_metadata(contents):
    with tarfile.open(fileobj=io.BytesIO(contents), mode="r:gz") as archive:
        controls = [entry for entry in archive.getmembers()
                    if entry.isfile() and entry.name.lstrip("./") == "control"]
        if len(controls) != 1:
            raise ValueError("Expected one package control file")
        lines = archive.extractfile(controls[0]).read().decode("utf-8").splitlines()
    maintainers = [line for line in lines if line.startswith("Maintainer:")]
    if maintainers != ["Maintainer: " + PACKAGE_MAINTAINER]:
        raise ValueError("Package maintainer must contain only the project name")


def verify(package, snapshot):
    contents = package.read_bytes()
    members = {name: data for name, _, data in ar_members(contents)}
    if members.get("debian-binary") != b"2.0\n":
        raise ValueError("Invalid IPK package version")
    verify_control_metadata(members["control.tar.gz"])
    with tarfile.open(fileobj=io.BytesIO(members["data.tar.gz"]), mode="r:gz") as archive:
        files = {}
        for entry in archive.getmembers():
            if entry.isfile():
                files[entry.name.lstrip("./")] = archive.extractfile(entry).read()
    prefix = f"usr/palm/applications/{APP_ID}/"
    app = json.loads(files[prefix + "appinfo.json"])
    if app["id"] != APP_ID or app["main"] != "index.html":
        raise ValueError("Incorrect installer app metadata")
    manifest = json.loads(files[prefix + "payload/manifest.json"])
    inventory = json.loads((snapshot / "native.json").read_text(encoding="utf-8"))
    recipe_bytes = files[prefix + "payload/firmware-patches.json"]
    if hashlib.sha256(recipe_bytes).hexdigest() != manifest["firmwareRecipeSha256"]:
        raise ValueError("Firmware patch instructions changed during packaging.")
    generated = generated_files(json.loads(recipe_bytes))
    if manifest.get("option") != {"quickStartMode": "on"} or inventory.get("option") != manifest["option"]:
        raise ValueError("Package must apply the verified Q Start+ enabled preference.")
    if {e["path"] for e in inventory["files"]} != {e["path"] for e in manifest["files"]}:
        raise ValueError("Package is missing deployed components")
    for entry in manifest["files"]:
        if entry["path"] in generated:
            if prefix + "payload/" + entry["path"] in files:
                raise ValueError("The public IPK must not contain LG firmware source.")
            if generated[entry["path"]]["sha256"] != entry["sha256"] or generated[entry["path"]]["size"] != entry["size"]:
                raise ValueError("Generated firmware metadata mismatch.")
            continue
        data = files[prefix + "payload/" + entry["path"]]
        if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"Packager modified or omitted {entry['path']}")
        if data != (snapshot / entry["path"]).read_bytes():
            raise ValueError(f"Payload differs from the verified TV snapshot: {entry['path']}")
    source = Path(__file__).resolve().parent
    for name in ("installer.js", "restore.js", "bootstrap.js", "index.html", "setup.js", "setup.css", "appinfo.json", "icon.png", "brand-icon.png"):
        original = source / name if name in ("installer.js", "restore.js", "bootstrap.js") else source / "app" / name
        if files[prefix + name] != original.read_bytes():
            raise ValueError(f"Installer source was modified during packaging: {name}")
    saved = json.loads(files[prefix + "payload/web/data/settings.json"])
    digest = hashlib.sha256(contents).hexdigest()
    package.with_suffix(package.suffix + ".sha256").write_text(
        digest + "  " + package.name + "\n", encoding="ascii"
    )
    print(json.dumps({
        "package": str(package.resolve()),
        "bytes": len(contents),
        "sha256": digest,
        "verifiedRuntimeFiles": len(manifest["files"]),
        "wallpaperMode": saved["wallpaperMode"],
        "screensaverMode": saved["screensaverMode"],
        "screensaverSeconds": saved["screensaverSeconds"],
        "quickStartMode": manifest["option"]["quickStartMode"],
        "requiresRootedHomebrew": True,
        "applyOnFirstLaunch": True,
        "containsLGFirmwareSource": False,
        "overlaysGeneratedOnTV": True,
    }, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path)
    parser.add_argument("--snapshot", type=Path, required=True)
    arguments = parser.parse_args()
    verify(arguments.package, arguments.snapshot)
