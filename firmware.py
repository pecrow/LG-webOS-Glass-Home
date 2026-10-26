import difflib
import hashlib
import json


def digest(data):
    return hashlib.sha256(data).hexdigest()


def make_pieces(original, inserted):
    width = 16
    index = {}
    for offset in range(max(0, len(original) - width + 1)):
        index.setdefault(original[offset:offset + width], offset)
    pieces = []
    literal = bytearray()
    offset = 0
    while offset < len(inserted):
        source = index.get(inserted[offset:offset + width]) if len(inserted) - offset >= width and inserted[offset] & 0xC0 != 0x80 else None
        if source is None:
            literal.append(inserted[offset])
            offset += 1
            continue
        if literal:
            pieces.append({"text": literal.decode("utf-8")})
            literal.clear()
        count = width
        while offset + count < len(inserted) and source + count < len(original) and inserted[offset + count] == original[source + count]:
            count += 1
        # Keep UTF-8 characters intact at literal boundaries.
        while count and offset + count < len(inserted) and inserted[offset + count] & 0xC0 == 0x80:
            count -= 1
        if not count:
            literal.append(inserted[offset])
            offset += 1
            continue
        pieces.append({"copy": source, "length": count})
        offset += count
    if literal:
        pieces.append({"text": literal.decode("utf-8")})
    return pieces


def recipes(snapshot):
    existing = snapshot / "firmware-patches.json"
    if existing.exists():
        return json.loads(existing.read_text(encoding="utf-8"))
    result = {"format": 1, "files": []}
    originals = snapshot / "original"
    for source in sorted(originals.rglob("*")):
        if not source.is_file():
            continue
        name = source.relative_to(originals).as_posix()
        original = source.read_bytes()
        patched = (snapshot / "patched" / name).read_bytes()
        old_lines = original.splitlines(keepends=True)
        new_lines = patched.splitlines(keepends=True)
        offsets = [0]
        for line in old_lines:
            offsets.append(offsets[-1] + len(line))
        edits = []
        for tag, a, b, c, d in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
            if tag != "equal":
                edits.append({"at": offsets[a], "remove": offsets[b] - offsets[a],
                              "pieces": make_pieces(original, b"".join(new_lines[c:d]))})
        result["files"].append({
            "name": name, "originalSize": len(original), "originalSha256": digest(original),
            "patchedSize": len(patched), "patchedSha256": digest(patched), "edits": edits,
        })
    if not result["files"]:
        raise ValueError("No firmware patch instructions were supplied.")
    return result


def generated_files(recipe):
    result = {}
    for entry in recipe["files"]:
        for kind in ("original", "patched"):
            name = kind + "/" + entry["name"]
            if name in result or ".." in name.split("/") or name.startswith("/"):
                raise ValueError("Unsafe firmware patch entry.")
            result[name] = {"size": entry[kind + "Size"], "sha256": entry[kind + "Sha256"]}
    return result
