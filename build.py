import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

from verify import PACKAGE_MAINTAINER, ar_members, verify
from firmware import generated_files, recipes


ROOT = Path(__file__).resolve().parent
APP_ID = "org.webosbrew.b9homecustom"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalize_package_metadata(package):
    members = ar_members(package.read_bytes())
    if {name for name, _, _ in members} != {"debian-binary", "control.tar.gz", "data.tar.gz"}:
        raise ValueError("Unexpected package members")
    output = bytearray(b"!<arch>\n")
    for name, header, data in members:
        if name == "control.tar.gz":
            buffer = io.BytesIO()
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
                with tarfile.open(fileobj=buffer, mode="w:gz") as target:
                    controls = 0
                    for entry in source.getmembers():
                        if entry.name.lstrip("./") == "control.sign":
                            raise ValueError("Cannot rewrite signed package metadata")
                        body = source.extractfile(entry).read() if entry.isfile() else None
                        if entry.isfile() and entry.name.lstrip("./") == "control":
                            lines = body.decode("utf-8").splitlines()
                            if sum(line.startswith("Maintainer:") for line in lines) != 1:
                                raise ValueError("Expected one package maintainer")
                            body = ("\n".join("Maintainer: " + PACKAGE_MAINTAINER
                                    if line.startswith("Maintainer:") else line
                                    for line in lines) + "\n").encode("utf-8")
                            entry.size = len(body)
                            controls += 1
                        target.addfile(entry, io.BytesIO(body) if body is not None else None)
                    if controls != 1:
                        raise ValueError("Expected one package control file")
            data = buffer.getvalue()
            header = header[:48] + str(len(data)).ljust(10).encode("ascii") + header[58:]
        output.extend(header)
        output.extend(data)
        if len(data) % 2:
            output.extend(b"\n")
    package.write_bytes(output)


def build(snapshot, output):
    snapshot = snapshot.resolve()
    output = output.resolve()
    inventory = json.loads((snapshot / "native.json").read_text(encoding="utf-8"))
    if inventory.get("option") != {"quickStartMode": "on"}:
        raise ValueError("Capture the verified Q Start+ enabled preference before building.")
    output.mkdir(parents=True, exist_ok=False)
    app = output / "app"
    shutil.copytree(ROOT / "app", app)
    shutil.copyfile(ROOT / "installer.js", app / "installer.js")
    shutil.copyfile(ROOT / "restore.js", app / "restore.js")
    shutil.copyfile(ROOT / "bootstrap.js", app / "bootstrap.js")
    payload = app / "payload"
    payload.mkdir()
    recipe = recipes(snapshot)
    generated = generated_files(recipe)
    recipe_bytes = (json.dumps(recipe, separators=(",", ":")) + "\n").encode("utf-8")
    (payload / "firmware-patches.json").write_bytes(recipe_bytes)
    files = []
    for entry in inventory["files"]:
        name = entry["path"]
        if "\\" in name or name.startswith("/") or ".." in name.split("/"):
            raise ValueError(f"Invalid snapshot path: {name}")
        if name in generated:
            if generated[name]["size"] != entry["size"] or generated[name]["sha256"] != entry["sha256"]:
                raise ValueError(f"Firmware instructions differ from the supported runtime: {name}")
            files.append(dict(entry, mode=0o644))
            continue
        source = snapshot / name
        data = source.read_bytes()
        if len(data) != entry["size"] or sha(data) != entry["sha256"]:
            raise ValueError(f"Snapshot checksum mismatch: {name}")
        target = payload / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append(dict(entry, mode=0o755 if name.endswith(".sh") else 0o644))
    manifest = {
        "format": 1,
        "version": json.loads((app / "appinfo.json").read_text(encoding="utf-8"))["version"],
        "testedModel": "LG OLED55B9PSB",
        "testedFirmware": "05.50.00 / webOS 4.10.2",
        "releaseSha256": sha(inventory["release"].encode("utf-8")),
        "general": inventory["general"],
        "option": inventory["option"],
        "configs": inventory["configs"],
        "files": files,
        "firmwareRecipeSha256": sha(recipe_bytes),
    }
    (payload / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    packager = shutil.which("ares-package") or shutil.which("ares-package.cmd")
    if not packager:
        raise RuntimeError("The installed webOS ares-package CLI is required.")
    subprocess.run([packager, "--no-minify", str(app), "--outdir", str(output)], check=True)
    packages = list(output.glob(f"{APP_ID}_*.ipk"))
    if len(packages) != 1:
        raise RuntimeError("Expected exactly one completed IPK.")
    package = packages[0]
    normalize_package_metadata(package)
    verify(package, snapshot)
    print(f"BUILT {package}")
    return package


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=ROOT / "runtime")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.snapshot, args.output)
