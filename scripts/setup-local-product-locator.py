#!/usr/bin/env python3
"""Download public, pinned vision assets. Never uploads a room or reads an API key."""
import hashlib
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "data/local-vision"
MODELS = [
    {"id": "IDEA-Research/grounding-dino-tiny", "revision": "a2bb814dd30d776dcf7e30523b00659f4f141c71", "directory": "grounding-dino-tiny", "license": "Apache-2.0"},
    {"id": "facebook/sam-vit-base", "revision": "70c1a07f894ebb5b307fd9eaaee97b9dfc16068f", "directory": "sam-vit-base", "license": "Apache-2.0"},
]

def main():
    # Public weights only; do not inherit a Hugging Face or OpenAI credential.
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from huggingface_hub import snapshot_download
    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest = {"schema_version": "local-product-locator.models.v1", "created_at": datetime.now(timezone.utc).isoformat(), "models": [], "paid_api_calls": 0, "image_uploads": 0}
    for entry in MODELS:
        target = ASSETS / entry["directory"]
        print("Downloading public model " + entry["id"], file=sys.stderr)
        snapshot_download(repo_id=entry["id"], revision=entry["revision"], local_dir=target,
                          allow_patterns=["*.json", "*.txt", "*.safetensors", "README.md"], token=False, max_workers=2)
        files = []
        for path in sorted(target.iterdir()):
            if path.is_file():
                files.append({"path": path.name, "bytes": path.stat().st_size, "sha256": hashlib.file_digest(path.open("rb"), "sha256").hexdigest()})
        manifest["models"].append({**entry, "files": files})
    (ASSETS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"ok": True, "manifest": str(ASSETS / "manifest.json"), "weight_bytes": sum(f["bytes"] for m in manifest["models"] for f in m["files"]), "paid_api_calls": 0}))

if __name__ == "__main__":
    main()
