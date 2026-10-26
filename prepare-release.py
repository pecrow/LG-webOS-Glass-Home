import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from build import build
from firmware import generated_files, recipes


ROOT = Path(__file__).resolve().parent


def prepare(snapshot, output):
    snapshot = snapshot.resolve()
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"Release destination already exists: {output}")
    inventory = json.loads((snapshot / "native.json").read_text(encoding="utf-8"))
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required to run the installer regression tests.")
    with tempfile.TemporaryDirectory(prefix="b9-home-release-") as temporary:
        staging = Path(temporary)
        public_snapshot = staging / "snapshot"
        public_snapshot.mkdir()
        recipe = recipes(snapshot)
        generated = generated_files(recipe)
        (public_snapshot / "firmware-patches.json").write_text(
            json.dumps(recipe, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        for entry in inventory["files"]:
            name = entry["path"]
            if "\\" in name or name.startswith("/") or ".." in name.split("/"):
                raise ValueError(f"Invalid snapshot path: {name}")
            if name in generated:
                if generated[name]["sha256"] != entry["sha256"] or generated[name]["size"] != entry["size"]:
                    raise ValueError(f"Invalid firmware instructions for {name}")
                continue
            data = (snapshot / name).read_bytes()
            if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError(f"Snapshot checksum mismatch: {name}")
            if name == "web/data/settings.json":
                settings = json.loads(data)
                settings.update(showWeather=False, showWeatherDock=False, weatherLocation=None,
                                hideInputsButton=False, hideHintButton=False)
                data = (json.dumps(settings, separators=(",", ":")) + "\n").encode("utf-8")
                entry.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
            target = public_snapshot / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (public_snapshot / "native.json").write_text(
            json.dumps(inventory, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        package = build(public_snapshot, staging / "build")
        subprocess.run([os.sys.executable, str(ROOT / "test.py"), "--runtime", str(public_snapshot)], check=True)
        output.mkdir(parents=True, exist_ok=False)
        shutil.copy2(package, output / package.name)
        shutil.copy2(package.with_suffix(".ipk.sha256"), output / (package.name + ".sha256"))
        shutil.copy2(ROOT / "README.md", output / "README.md")
        shutil.copytree(ROOT / "images", output / "images")
    print(f"LOCAL RELEASE READY {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Prepare a local release with location-free weather defaults; never publish."
    )
    parser.add_argument("--snapshot", type=Path, default=ROOT / "runtime")
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.snapshot, arguments.output)
