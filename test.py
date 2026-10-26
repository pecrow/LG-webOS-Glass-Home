import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile

from build import normalize_package_metadata
from verify import ar_members, verify_control_metadata


ROOT = Path(__file__).resolve().parent


def check_package_metadata():
    with tempfile.TemporaryDirectory(prefix="glass-package-metadata-") as directory:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            body = b"Package: fixture\nMaintainer: Build tool default\nVersion: 1.0.0\n"
            entry = tarfile.TarInfo("./control")
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
        control = buffer.getvalue()
        try:
            verify_control_metadata(control)
        except ValueError:
            pass
        else:
            raise AssertionError("Non-project maintainer was accepted")
        payload = b"Application payload must remain byte-identical"
        contents = bytearray(b"!<arch>\n")
        for name, data in [("debian-binary", b"2.0\n"), ("control.tar.gz", control),
                           ("data.tar.gz", payload)]:
            header = (f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n")
            contents.extend(header.encode("ascii") + data + (b"\n" if len(data) % 2 else b""))
        package = Path(directory) / "fixture.ipk"
        package.write_bytes(contents)
        normalize_package_metadata(package)
        members = {name: data for name, _, data in ar_members(package.read_bytes())}
        verify_control_metadata(members["control.tar.gz"])
        assert members["data.tar.gz"] == payload
        assert members["debian-binary"] == b"2.0\n"
        with tarfile.open(fileobj=io.BytesIO(members["control.tar.gz"]), mode="r:gz") as archive:
            lines = archive.extractfile("./control").read().decode().splitlines()
        assert "Package: fixture" in lines and "Version: 1.0.0" in lines
        try:
            ar_members(bytes(contents[:20]))
        except ValueError:
            pass
        else:
            raise AssertionError("Truncated package was accepted")
    print("PASS project-only package metadata; application payload remains unchanged")


def run(runtime):
    check_package_metadata()
    inventory = json.loads((runtime / "native.json").read_text(encoding="utf-8"))
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for tests.")
    with tempfile.TemporaryDirectory(prefix="glass-home-tests-") as directory:
        payload = Path(directory)
        entries = []
        for entry in inventory["files"]:
            name = entry["path"]
            if name.startswith("original/"):
                data = ("// Synthetic factory fixture: " + name[9:] + "\nItem {}\n").encode()
            elif name.startswith("patched/") and (runtime / "original" / name[8:]).exists():
                data = ("// Synthetic customization fixture: " + name[8:] + "\nItem {}\n").encode()
            elif name.startswith("patched/") and not (runtime / name).exists():
                data = ("// Synthetic customization fixture: " + name[8:] + "\nItem {}\n").encode()
            else:
                data = (runtime / name).read_bytes()
            target = payload / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            entries.append(dict(entry, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
        release = "Synthetic Glass Home test firmware\n"
        manifest = {
            "format": 1, "version": "1.0.0", "releaseSha256": hashlib.sha256(release.encode()).hexdigest(),
            "general": inventory["general"], "option": inventory["option"], "configs": inventory["configs"],
            "files": entries,
        }
        (payload / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        subprocess.run([node, str(ROOT / "test.js"), str(payload)],
                       env=dict(os.environ, B9_TEST_RELEASE=release), check=True)
        subprocess.run([node, str(ROOT / "bootstrap.test.js")], check=True)
        subprocess.run([node, str(ROOT / "video.test.js"), str(runtime)], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run tests using synthetic firmware; no LG source is required.")
    parser.add_argument("--runtime", type=Path, default=ROOT / "runtime")
    run(parser.parse_args().runtime.resolve())
