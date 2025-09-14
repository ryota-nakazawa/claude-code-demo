# server/app.py
# -*- coding: utf-8 -*-
import os
import re
import json
import time
import asyncio
import shutil
import difflib
import mimetypes
import logging
from typing import Dict, Any, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from claude_code_sdk import ClaudeSDKClient, ClaudeCodeOptions

# ------------------------------------------------------------
# Logging & Flags
# ------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
LOG = logging.getLogger("server")

# SDK permission mode: "acceptEdits" (auto-apply) / "requestApproval" (SDK might ask)
CLAUDE_PERMISSION_MODE = os.getenv("CLAUDE_PERMISSION_MODE", "acceptEdits")

# Human approval flow: if true, write to output_pending first and require promote()
REQUIRE_APPROVAL = os.getenv("REQUIRE_APPROVAL", "1") in ("1", "true", "True")

# ------------------------------------------------------------
# Paths
# ------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")

# ------------------------------------------------------------
# App
# ------------------------------------------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------
# Models
# ------------------------------------------------------------
class AskBody(BaseModel):
    prompt: str
    project_id: str

class PromoteBody(BaseModel):
    project_id: str
    from_rel: str                 # e.g. "output_pending/議事録.md"
    to_rel: Optional[str] = None  # default: same name under final_write_dir
    overwrite: bool = True

# ------------------------------------------------------------
# Utils
# ------------------------------------------------------------
IGNORE_NAMES = {".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".DS_Store"}
MAX_PREVIEW_BYTES = 200 * 1024

def _is_subpath(child: str, parents: List[str]) -> bool:
    child = os.path.realpath(child)
    for p in parents:
        rp = os.path.realpath(p)
        if child == rp or child.startswith(rp + os.sep):
            return True
    return False

def _safe_join(root: str, rel: str) -> str:
    rel = (rel or "").lstrip("/").replace("\\", "/")
    abspath = os.path.realpath(os.path.join(root, rel))
    rroot = os.path.realpath(root)
    if not (abspath == rroot or abspath.startswith(rroot + os.sep)):
        raise HTTPException(400, "invalid path")
    return abspath

def _sse_headers():
    return {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

def load_manifest(project_id: str) -> Dict[str, Any]:
    safe = re.fullmatch(r"[a-zA-Z0-9_\-]+", project_id)
    if not safe:
        raise HTTPException(400, "invalid project_id")
    project_root = os.path.join(PROJECTS_DIR, project_id)
    manifest_path = os.path.join(project_root, "manifest.json")
    if not os.path.exists(manifest_path):
        raise HTTPException(404, f"manifest not found: {project_id}")
    with open(manifest_path, "r", encoding="utf-8") as f:
        m = json.load(f)

    read_dirs_rel: List[str] = list(m.get("read_dirs", []))
    read_dirs_abs: List[str] = [os.path.join(project_root, d) for d in read_dirs_rel]

    # approval ON → write into output_pending; otherwise write_dir as-is
    final_write_rel = m.get("write_dir", "output")
    write_dir_rel = "output_pending" if REQUIRE_APPROVAL else final_write_rel
    write_dir_abs = os.path.join(project_root, write_dir_rel)
    os.makedirs(write_dir_abs, exist_ok=True)

    m["_project_root"] = project_root
    m["_read_dirs_rel"] = read_dirs_rel
    m["_read_dirs_abs"] = read_dirs_abs
    m["_write_dir_rel"] = write_dir_rel
    m["_write_dir_abs"] = write_dir_abs
    m["_final_write_rel"] = final_write_rel
    return m

def build_alias_hint(manifest: Dict[str, Any]) -> str:
    aliases: Dict[str, str] = manifest.get("aliases", {})
    if not aliases:
        return ""
    lines = ["\nPROJECT FILE ALIASES (use with Read/Write):"]
    for k, v in aliases.items():
        lines.append(f"- {k} => {v}")
    lines.append(
        "When the user mentions an alias (e.g., @routes), use Read/Write with "
        "paths relative to the project root. If target does not exist, create it "
        "under the current write directory shown above."
    )
    return "\n".join(lines)

def make_system_prompt(m: Dict[str, Any]) -> str:
    """System prompt with path normalization & append rules."""
    return (
        "You are a careful coding assistant working inside a team project.\n"
        "Rules:\n"
        f"- Project root: {m['_project_root']}\n"
        f"- Read-only dirs: {', '.join(m['_read_dirs_rel'])}\n"
        f"- Current write dir (CWD for Write): {m['_write_dir_rel']}\n"
        "- Always show concrete relative paths you touched.\n"
        "- Prefer Read/Write tools with explicit relative paths.\n"
        # Path normalization so the model doesn't create nested folders
        f"- IMPORTANT: The Write tool's working directory is {m['_write_dir_rel']}. "
        f"If you see a path starting with '{m['_write_dir_rel']}/' (e.g., '@{m['_write_dir_rel']}/foo.md'), "
        "STRIP that leading folder and write to the relative path instead (write 'foo.md'). "
        "Do NOT create nested '<write_dir>/<write_dir>/' paths.\n"
        # Append workflow to reduce 'no-op' writes
        "- For 'append' requests: Read the existing file, merge by appending your new section, "
        "then Write the full updated content back to the SAME filename.\n"
    )

# ------------------------------------------------------------
# Health
# ------------------------------------------------------------
@app.get("/_health")
def _health():
    return {"ok": True, "anthropic_key": bool(os.getenv("ANTHROPIC_API_KEY"))}

# ------------------------------------------------------------
# FS APIs (list/search/preview)
# ------------------------------------------------------------
@app.get("/projects")
async def list_projects():
    items = []
    if not os.path.exists(PROJECTS_DIR):
        return items
    for name in sorted(os.listdir(PROJECTS_DIR)):
        mp = os.path.join(PROJECTS_DIR, name, "manifest.json")
        if os.path.isfile(mp):
            try:
                with open(mp, "r", encoding="utf-8") as f:
                    m = json.load(f)
                items.append({
                    "id": name,
                    "name": m.get("name", name),
                    "aliases": m.get("aliases", {}),
                })
            except Exception:
                pass
    return items

@app.get("/projects/{project_id}")
async def get_project(project_id: str):
    m = load_manifest(project_id)
    return {
        "id": project_id,
        "name": m.get("name", project_id),
        "aliases": m.get("aliases", {}),
        "read_dirs": m["_read_dirs_rel"],
        "write_dir": m["_write_dir_rel"],          # current (may be output_pending)
        "final_write_dir": m["_final_write_rel"],  # after approval
        "require_approval": REQUIRE_APPROVAL,
    }

@app.get("/projects/{project_id}/fs")
async def list_fs(project_id: str, path: Optional[str] = None):
    m = load_manifest(project_id)
    project_root = m["_project_root"]

    roots_rel = list(m["_read_dirs_rel"])
    if m["_write_dir_rel"] not in roots_rel:
        roots_rel.append(m["_write_dir_rel"])
    roots_abs = [os.path.join(project_root, r) for r in roots_rel]

    if not path:
        items = []
        for r in roots_rel:
            abs_r = os.path.join(project_root, r)
            if os.path.exists(abs_r):
                items.append({"name": os.path.basename(r), "rel": r, "type": "dir"})
        return {"items": items}

    abs_target = _safe_join(project_root, path)
    if not _is_subpath(abs_target, roots_abs):
        raise HTTPException(403, "path not allowed")
    if not os.path.isdir(abs_target):
        raise HTTPException(400, "not a directory")

    items = []
    try:
        with os.scandir(abs_target) as it:
            for e in it:
                name = e.name
                if name in IGNORE_NAMES or name.startswith("."):
                    continue
                items.append({
                    "name": name,
                    "rel": os.path.join(path, name).replace("\\", "/"),
                    "type": "dir" if e.is_dir(follow_symlinks=False) else "file"
                })
    except FileNotFoundError:
        items = []
    items.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
    return {"items": items}

@app.get("/projects/{project_id}/search")
async def search_files(project_id: str, q: str, limit: int = 200):
    if not q:
        return {"items": []}
    ql = q.lower()

    m = load_manifest(project_id)
    project_root = m["_project_root"]
    roots_rel = list(m["_read_dirs_rel"])
    if m["_write_dir_rel"] not in roots_rel:
        roots_rel.append(m["_write_dir_rel"])
    roots_abs = [os.path.join(project_root, r) for r in roots_rel]

    results = []
    for r_abs, r_rel in zip(roots_abs, roots_rel):
        if not os.path.exists(r_abs):
            continue
        for dirpath, dirnames, filenames in os.walk(r_abs):
            dirnames[:] = [d for d in dirnames if d not in IGNORE_NAMES and not d.startswith(".")]
            for name in dirnames + filenames:
                if name in IGNORE_NAMES or name.startswith("."):
                    continue
                if ql not in name.lower():
                    continue
                abs_path = os.path.join(dirpath, name)
                typ = "dir" if os.path.isdir(abs_path) else "file"
                rel_path = os.path.relpath(abs_path, project_root).replace("\\", "/")
                results.append({"name": name, "rel": rel_path, "type": typ})
                if len(results) >= max(1, min(limit, 1000)):
                    return {"items": results}
    return {"items": results}

@app.get("/projects/{project_id}/file")
async def get_file(project_id: str, path: str):
    if not path:
        raise HTTPException(400, "path required")

    m = load_manifest(project_id)
    project_root = m["_project_root"]

    roots_rel = list(m["_read_dirs_rel"])
    if m["_write_dir_rel"] not in roots_rel:
        roots_rel.append(m["_write_dir_rel"])
    roots_abs = [os.path.join(project_root, r) for r in roots_rel]

    abs_path = _safe_join(project_root, path)
    if not _is_subpath(abs_path, roots_abs):
        raise HTTPException(403, "path not allowed")
    if not os.path.isfile(abs_path):
        raise HTTPException(404, "not a file")

    size = os.path.getsize(abs_path)
    mime, _ = mimetypes.guess_type(abs_path)
    with open(abs_path, "rb") as f:
        data = f.read(min(size, MAX_PREVIEW_BYTES))

    is_text = False
    text = ""
    if b"\x00" not in data:
        try:
            text = data.decode("utf-8")
            is_text = True
        except UnicodeDecodeError:
            text = data.decode("utf-8", errors="replace")
            is_text = True

    resp = {
        "name": os.path.basename(abs_path),
        "rel": path,
        "size": size,
        "mime": mime or "application/octet-stream",
        "is_text": is_text,
    }
    if is_text:
        resp["content"] = text
        resp["truncated"] = size > MAX_PREVIEW_BYTES
    else:
        resp["note"] = "binary or unsupported text; preview omitted"
    return resp

# ------------------------------------------------------------
# /ask (batch)
# ------------------------------------------------------------
@app.post("/ask")
async def ask(body: AskBody):
    m = load_manifest(body.project_id)

    system_prompt = make_system_prompt(m)
    options = ClaudeCodeOptions(
        system_prompt=system_prompt,
        max_turns=8,
        allowed_tools=["Read", "Write", "Bash"],
        cwd=m["_write_dir_abs"],
        add_dirs=m["_read_dirs_abs"],
        permission_mode=CLAUDE_PERMISSION_MODE,
    )

    user_prompt = body.prompt
    prompt = user_prompt + build_alias_hint(m) + """
MANDATORY ACTIONS:
- Use the Read tool to actually open every referenced file (do not just say you'll read).
- Produce the final artifact.
- Use the Write tool to save under the current write dir shown above.
- After writing, print the exact relative path as @<path> so the UI can detect it.
"""

    start_ts = time.time()
    try:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(prompt)

            chunks: List[str] = []
            meta: Optional[Dict[str, Any]] = None

            async for message in client.receive_response():
                if hasattr(message, "content") and isinstance(message.content, list):
                    for block in message.content:
                        if hasattr(block, "text") and isinstance(block.text, str):
                            chunks.append(block.text)
                if hasattr(message, "duration_ms") or hasattr(message, "total_cost_usd"):
                    meta = {
                        "duration_ms": getattr(message, "duration_ms", None),
                        "turns": getattr(message, "num_turns", None),
                        "total_cost_usd": getattr(message, "total_cost_usd", None),
                        "usage": getattr(message, "usage", None),
                    }

            # detect files written during this call
            written: List[str] = []
            for root, _, files in os.walk(m["_write_dir_abs"]):
                for name in files:
                    p = os.path.join(root, name)
                    try:
                        if os.path.getmtime(p) >= start_ts - 0.5:
                            rel = os.path.relpath(p, m["_project_root"]).replace("\\", "/")
                            written.append(rel)
                    except FileNotFoundError:
                        pass

            if meta is None:
                meta = {}
            meta.update({
                "write_dir": m["_write_dir_rel"],
                "final_write_dir": m["_final_write_rel"],
                "require_approval": REQUIRE_APPROVAL,
                "written": sorted(set(written)),
            })

            return {"text": "".join(chunks), "meta": meta}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ------------------------------------------------------------
# /ask/stream (SSE)
# ------------------------------------------------------------
@app.get("/ask/stream")
async def ask_stream(project_id: str, prompt: str):
    m = load_manifest(project_id)

    system_prompt = make_system_prompt(m)
    options = ClaudeCodeOptions(
        system_prompt=system_prompt,
        max_turns=8,
        allowed_tools=["Read", "Write", "Bash"],
        cwd=m["_write_dir_abs"],
        add_dirs=m["_read_dirs_abs"],
        permission_mode=CLAUDE_PERMISSION_MODE,
    )

    async def gen():
        start_ts = time.time()
        yield {"event": "status", "data": json.dumps({"stage": "open"})}
        LOG.info("[SSE] open project=%s", project_id)

        try:
            async with ClaudeSDKClient(options=options) as client:
                yield {"event": "status", "data": json.dumps({"stage": "query_start"})}
                LOG.info("[SSE] query start")

                await client.query(
                    prompt + build_alias_hint(m)
                    + "\n\nPlease perform the plan. Use the current write dir above when creating files."
                )

                yield {"event": "status", "data": json.dumps({"stage": "generating"})}
                LOG.info("[SSE] generating…")

                async for message in client.receive_response():
                    LOG.debug("[SSE] msg: %s", getattr(message, "type", type(message)))
                    if hasattr(message, "content") and isinstance(message.content, list):
                        for block in message.content:
                            if hasattr(block, "text") and isinstance(block.text, str):
                                yield {"event": "chunk", "data": json.dumps({"text": block.text})}
                    elif hasattr(message, "text") and isinstance(message.text, str):
                        yield {"event": "chunk", "data": json.dumps({"text": message.text})}
                    elif hasattr(message, "delta") and isinstance(getattr(message, "delta"), dict):
                        t = message.delta.get("text")
                        if isinstance(t, str) and t:
                            yield {"event": "chunk", "data": json.dumps({"text": t})}

                # notify files written
                written = []
                for root, _, files in os.walk(m["_write_dir_abs"]):
                    for name in files:
                        p = os.path.join(root, name)
                        try:
                            if os.path.getmtime(p) >= start_ts - 0.5:
                                rel = os.path.relpath(p, m["_project_root"]).replace("\\", "/")
                                written.append(rel)
                        except FileNotFoundError:
                            pass
                for rel in sorted(set(written)):
                    LOG.info("[SSE] file_written %s", rel)
                    yield {"event": "file_written", "data": json.dumps({"path": f"@{rel}"})}

                LOG.info("[SSE] done")
                yield {"event": "done", "data": json.dumps({
                    "ok": True,
                    "write_dir": m["_write_dir_rel"],
                    "final_write_dir": m["_final_write_rel"],
                    "require_approval": REQUIRE_APPROVAL,
                })}

        except Exception as e:
            LOG.exception("[SSE] error")
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(gen(), headers=_sse_headers(), ping=15)

# ------------------------------------------------------------
# Approval flow: promote / delete staged / diff
# ------------------------------------------------------------
@app.post("/projects/{project_id}/promote")
async def promote_file(project_id: str, body: PromoteBody):
    m = load_manifest(project_id)
    project_root = m["_project_root"]

    from_rel = (body.from_rel or "").lstrip("/")
    if not from_rel.startswith(m["_write_dir_rel"] + "/"):
        raise HTTPException(400, f"from_rel must start with {m['_write_dir_rel']}/")
    src_abs = _safe_join(project_root, from_rel)
    if not os.path.isfile(src_abs):
        raise HTTPException(404, "staged file not found")

    if body.to_rel:
        to_rel = body.to_rel.lstrip("/")
    else:
        # keep same suffix under final_write_dir
        suffix = from_rel.split("/", 1)[1] if "/" in from_rel else os.path.basename(from_rel)
        to_rel = f"{m['_final_write_rel']}/{suffix}"

    dst_abs = _safe_join(project_root, to_rel)
    os.makedirs(os.path.dirname(dst_abs), exist_ok=True)

    if os.path.exists(dst_abs) and not body.overwrite:
        raise HTTPException(409, "destination exists")

    shutil.copy2(src_abs, dst_abs)
    return {"promoted_to": to_rel}

@app.delete("/projects/{project_id}/staged")
async def delete_staged(project_id: str, path: str):
    m = load_manifest(project_id)
    project_root = m["_project_root"]
    rel = (path or "").lstrip("/")
    if not rel.startswith(m["_write_dir_rel"] + "/"):
        raise HTTPException(400, f"path must start with {m['_write_dir_rel']}/")
    abs_p = _safe_join(project_root, rel)
    if os.path.isfile(abs_p):
        os.remove(abs_p)
        return {"deleted": rel}
    raise HTTPException(404, "not found")

@app.get("/projects/{project_id}/diff")
async def get_diff(project_id: str, from_rel: str, to_rel: Optional[str] = None):
    m = load_manifest(project_id)
    project_root = m["_project_root"]

    from_rel = (from_rel or "").lstrip("/")
    if not from_rel.startswith(m["_write_dir_rel"] + "/"):
        raise HTTPException(400, f"from_rel must start with {m['_write_dir_rel']}/")
    src_abs = _safe_join(project_root, from_rel)
    if not os.path.isfile(src_abs):
        raise HTTPException(404, "staged not found")

    if not to_rel:
        suffix = from_rel.split("/", 1)[1] if "/" in from_rel else os.path.basename(from_rel)
        to_rel = f"{m['_final_write_rel']}/{suffix}"
    dst_abs = _safe_join(project_root, to_rel)

    def _read_lines(p):
        if not os.path.exists(p):
            return []
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read().splitlines(keepends=False)

    a = _read_lines(dst_abs)  # existing/final
    b = _read_lines(src_abs)  # staged
    udiff = difflib.unified_diff(a, b, fromfile=to_rel, tofile=from_rel, lineterm="")
    return {"diff": "\n".join(list(udiff))}

# ------------------------------------------------------------
# Debug SSE (quick check)
# ------------------------------------------------------------
@app.get("/debug/stream")
async def debug_stream():
    async def gen():
        for i in range(1, 6):
            yield {"event": "chunk", "data": json.dumps({"text": f"[tick {i}]\n"})}
            await asyncio.sleep(1)
        yield {"event": "done", "data": json.dumps({"ok": True})}
    return EventSourceResponse(gen(), headers=_sse_headers(), ping=10)
