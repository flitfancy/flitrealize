#!/usr/bin/env python3
"""Import inert API Markdown from a pinned official repository ZIP."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
KINDS = {"classes": "class", "enums": "enum", "interfaces": "interface", "types": "type"}
REPOSITORY = "https://github.com/easyeda/easyeda-api-skill"

def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()

def build_reference(archive_path: Path, commit: str, snapshot: str) -> tuple[dict, dict]:
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected the full pinned official repository commit SHA")
    archive_bytes = archive_path.read_bytes()
    with zipfile.ZipFile(archive_path) as archive:
        packages = [name for name in archive.namelist() if name.endswith("/package.json") and name.count("/") == 1]
        if len(packages) != 1:
            raise ValueError("Expected one official repository root")
        prefix = packages[0].removesuffix("package.json")
        if not prefix.rstrip("/").endswith(commit):
            raise ValueError("Repository ZIP root does not match the pinned commit")
        package = json.loads(archive.read(packages[0]))
        if package.get("name") != "easyeda-api":
            raise ValueError("Unexpected upstream package")
        skill = archive.read(prefix + "SKILL.md").decode("utf-8-sig")
        frontmatter = skill.split("---", 2)[1]
        version = re.search(r"^\s+version:\s*[\"']?([^\s\"']+)", frontmatter, re.MULTILINE)
        if not version or version.group(1) != package.get("version"):
            raise ValueError("Upstream package and metadata versions disagree")
        license_match = re.search(r"^license:\s*(.+)$", frontmatter, re.MULTILINE)
        entries, seen = [], set()
        for name in sorted(archive.namelist()):
            if not name.startswith(prefix + "references/") or not name.endswith(".md"):
                continue
            relative = PurePosixPath(name.removeprefix(prefix))
            if len(relative.parts) != 3 or relative.parts[1] not in KINDS:
                continue
            identity = relative.stem
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", identity) or identity.casefold() in seen:
                raise ValueError("Invalid or duplicate API identity: " + identity)
            seen.add(identity.casefold())
            original = archive.read(name)
            text = original.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
            entries.append({"id": identity, "kind": KINDS[relative.parts[1]], "text": text,
                "sourceUrl": "https://prodocs.lceda.cn/en/api/reference/pro-api." + identity.lower() + ".html",
                "sha256": sha(text.encode("utf-8")), "sourceFile": relative.as_posix(), "sourceSha256": sha(original)})
        if not entries:
            raise ValueError("Official archive contains no supported API references")
        standalone_license = any(prefix + name in archive.namelist() for name in ["LICENSE", "LICENSE.md", "LICENSE.txt"])
    source = {"name": package["name"], "version": package["version"], "snapshot": snapshot,
        "status": "official-repository-snapshot", "repository": REPOSITORY, "commit": commit,
        "officialReferenceBase": "https://prodocs.lceda.cn/en/api/reference/", "currentApiAvailability": "not-verified"}
    corpus = {"schemaVersion": 1, "source": source, "entries": entries}
    provenance = {"schemaVersion": 1, "source": source,
        "archive": {"name": archive_path.name, "url": "https://codeload.github.com/easyeda/easyeda-api-skill/zip/" + commit, "sha256": sha(archive_bytes)},
        "selection": {"directories": ["references/" + name for name in KINDS], "entryCount": len(entries), "counts": dict(Counter(e["kind"] for e in entries))},
        "normalization": "CR/CRLF normalized to LF. Entry sha256 covers stored UTF-8 text; sourceSha256 covers original archive bytes. Definitions, examples and notices are retained.",
        "attribution": {"author": "JLCEDA", "licenseDeclaration": license_match.group(1).strip() if license_match else "not-declared",
            "declarationSource": "upstream SKILL.md frontmatter", "standaloneLicenseFilePresent": standalone_license,
            "note": "Upstream declarations are recorded as provenance, not a new license grant or a claim about every document."},
        "scope": "Only API reference documents are imported. Upstream execution instructions, bridge code, dependencies, guides and project files are not imported or executed.",
        "freshness": "Pinned official documentation snapshot; documentation presence does not prove API availability or behavior in a target editor."}
    return corpus, provenance

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--snapshot", default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument("--output-dir", type=Path, default=ROOT / "adapters/easyeda-pro/api-reference")
    arguments = parser.parse_args()
    corpus, provenance = build_reference(arguments.archive, arguments.commit, arguments.snapshot)
    arguments.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in [("corpus.json", corpus), ("provenance.json", provenance)]:
        (arguments.output_dir / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"version": corpus["source"]["version"], "entries": len(corpus["entries"]), "counts": provenance["selection"]["counts"]}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
