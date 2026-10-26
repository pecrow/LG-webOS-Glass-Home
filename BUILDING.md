# Build LG webOS Glass Home

## Requirements

- Python 3.
- Node.js 18 or newer for the local tests.
- The webOS CLI, with `ares-package` available on your PATH.

The checked-in runtime, default background image, live wallpaper, and patch instructions are sufficient to build the IPK. No TV connection, credentials, environment file, or LG firmware download is needed on the build computer.

## Test

```text
python test.py
```

Tests use synthetic firmware fixtures, not LG source code. They cover installation, persistence, saved settings, stock restoration, interrupted restore recovery, and pointer-only activation.

## Build a release

```text
python prepare-release.py --output dist\release-v1.0
```

The destination must not already exist. The command builds the IPK, checks its contents, runs the tests, and writes the release README, images, and SHA-256 checksum. Use your platform's path separator.

For a package-only build:

```text
python build.py --output dist\package
```

## How the firmware-free package works

The public IPK contains application code and patch instructions, not LG's original or patched firmware files. On the supported TV, the installer checks the firmware version and original file hashes, then builds and verifies the native overlays locally. Original firmware bytes come only from that TV.

Generated files are cached locally outside the setup app. Existing Home settings and uploaded media are preserved during installation. Stock restoration removes the active customization and retains its data in a recovery archive. Fully restart the TV after a successful restoration before uninstalling the app.

The package is restricted to the documented LG B9 firmware. Different firmware fails verification rather than guessing how to patch it.
