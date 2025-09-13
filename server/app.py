# server/app.py
import os
import re
import json
import pathlib
import mimetypes
import asyncio
from typing import Dict, Any, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Claude Code SDK
from claude_code_sdk import ClaudeSDKClient, ClaudeCodeOptions

# ========== 基本設定 ==========
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")

app = FastAPI(title="Claude Code (Shared Projects)")

# フロント（Vite）からのアクセスを許可
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========== モデル ==========
class AskBody(BaseModel):
    prompt: str
    project_id: str

# ========== ユーティリティ（プロジェクト/パス） ==========
IGNORE_NAMES = {".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".DS_Store"}
MAX_PREVIEW_BYTES = 200 * 1024  # プレビュー上限
MAX_READ_BYTES = 200 * 1024     # LLMにインライン投入する上限

def load_manifest(project_id: str) -> Dict[str, Any]:
    # project_id は英数/ハイフン/アンダースコアのみ
    if not re.fullmatch(r"[a-zA-Z0-9_\-]+", project_id):
        raise HTTPException(400, "invalid project_id")
    project_root = os.path.join(PROJECTS_DIR, project_id)
    manifest_path = os.path.join(project_root, "manifest.json")
    if not os.path.exists(manifest_path):
        raise HTTPException(404, f"manifest not found: {project_id}")
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            m = json.load(f)
    except Exception as e:
        raise HTTPException(500, f"manifest parse error: {e}")

    # 絶対パスへ解決 & 出力先を用意
    read_dirs_abs: List[str] = []
    for d in m.get("read_dirs", []):
        read_dirs_abs.append(os.path.join(project_root, d))
    write_dir = m.get("write_dir", "output")  # 既定は output
    write_dir_abs = os.path.join(project_root, write_dir)
    os.makedirs(write_dir_abs, exist_ok=True)

    m["_project_root"] = project_root
    m["_read_dirs_abs"] = read_dirs_abs
    m["_write_dir_abs"] = write_dir_abs
    return m

def build_alias_hint(manifest: Dict[str, Any]) -> str:
    aliases: Dict[str, str] = manifest.get("aliases", {})
    if not aliases:
        return ""
    lines = ["\nPROJECT FILE ALIASES (use with @mention):"]
    for k, v in aliases.items():
        lines.append(f"- {k} => {v}")
    lines.append(
        "When the user mentions an alias (e.g., @input/foo.txt), resolve it relative to the project root.\n"
        "Read-only dirs are listed in read_dirs; write files only under write_dir.\n"
        "If an output path points to a directory, generate a sensible filename."
    )
    return "\n".join(lines)

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

# ========== メンション/パス解決 ==========
_mention_re = re.compile(r"@([\w\-\._/一-龯ぁ-んァ-ン]+)")

def _extract_mentions(s: str) -> List[str]:
    return [m.group(1) for m in _mention_re.finditer(s)]

def _aliases_maps(mani: Dict[str, Any]) -> Dict[str, str]:
    ali = mani.get("aliases", {}) or {}
    by_name: Dict[str, str] = {}
    for k, v in ali.items():
        key = k[1:] if k.startswith("@") else k
        by_name[key] = v
    return by_name

def _resolve_rel(project_root: str, mani: Dict[str, Any], token: str) -> str:
    """@input/foo.txt のようなトークンを安全な相対パスに解決"""
    token = token.lstrip("/")
    alias_map = _aliases_maps(mani)
    head, _, tail = token.partition("/")
    base = alias_map.get(head, head)
    rel = base if not tail else f"{base}/{tail}"
    abs_path = os.path.realpath(os.path.join(project_root, rel))
    rroot = os.path.realpath(project_root)
    if not (abs_path == rroot or abs_path.startswith(rroot + os.sep)):
        raise HTTPException(400, f"invalid path: {rel}")
    return os.path.relpath(abs_path, project_root).replace("\\", "/")

def _read_text_safe(abs_path: str) -> str:
    size = os.path.getsize(abs_path)
    if size > MAX_READ_BYTES:
        raise HTTPException(413, f"file too large to inline ({size} bytes > {MAX_READ_BYTES})")
    with open(abs_path, "rb") as f:
        data = f.read()
    if b"\x00" in data:
        raise HTTPException(415, "binary file is not previewable")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")

def _ensure_parent_dir(abs_path: str):
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)

# ========== プロジェクト API ==========
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
        "read_dirs": m.get("read_dirs", []),
        "write_dir": m.get("write_dir", "output"),
    }

# ========== ファイルツリー ==========
@app.get("/projects/{project_id}/fs")
async def list_fs(project_id: str, path: Optional[str] = None):
    """
    ルートなし: read_dirs + write_dir を返す
    pathあり : その配下の子を返す
    """
    m = load_manifest(project_id)
    project_root = m["_project_root"]
    read_dirs = list(m.get("read_dirs", []))
    write_dir = m.get("write_dir", "output")
    roots_rel = list(dict.fromkeys(read_dirs + [write_dir]))
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
    with os.scandir(abs_target) as it:
        for e in it:
            name = e.name
            if name in IGNORE_NAMES or name.startswith("."):
                continue
            typ = "dir" if e.is_dir(follow_symlinks=False) else "file"
            items.append({
                "name": name,
                "rel": os.path.join(path, name).replace("\\", "/"),
                "type": typ
            })
    items.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
    return {"items": items}

# ========== 検索 ==========
@app.get("/projects/{project_id}/search")
async def search_files(project_id: str, q: str, limit: int = 200):
    if not q:
        return {"items": []}
    ql = q.lower()

    m = load_manifest(project_id)
    project_root = m["_project_root"]
    read_dirs = list(m.get("read_dirs", []))
    write_dir = m.get("write_dir", "output")
    roots_rel = list(dict.fromkeys(read_dirs + [write_dir]))

    results = []
    for r_rel in roots_rel:
        r_abs = os.path.join(project_root, r_rel)
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

# ========== ファイルプレビュー ==========
@app.get("/projects/{project_id}/file")
async def get_file(project_id: str, path: str):
    if not path:
        raise HTTPException(400, "path required")

    m = load_manifest(project_id)
    project_root = m["_project_root"]
    read_dirs = list(m.get("read_dirs", []))
    write_dir = m.get("write_dir", "output")
    roots_rel = list(dict.fromkeys(read_dirs + [write_dir]))
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
    is_binary = (b"\x00" in data)
    is_text = False
    text = None
    if not is_binary:
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

# ========== LLM（テキストのみ；ツール不使用） ==========
async def _llm_complete_text(prompt: str) -> str:
    """ツールを使わず、テキスト回答だけを1ターンで取得"""
    options = ClaudeCodeOptions(
        system_prompt="You are a concise Japanese summarizer. Output ONLY the Markdown body.",
        max_turns=1,
        allowed_tools=[],  # ツール呼び出し禁止
    )
    async with ClaudeSDKClient(options=options) as client:
        await client.query(prompt)
        chunks: List[str] = []
        async for message in client.receive_response():
            if hasattr(message, "content") and isinstance(message.content, list):
                for block in message.content:
                    if hasattr(block, "text") and isinstance(block.text, str):
                        chunks.append(block.text)
        return "".join(chunks).strip()

# ========== タスク特化：要約→保存 ==========
def _looks_like_summarize(prompt: str, rels: List[str]) -> bool:
    kw = ("要約", "まとめ", "summarize", "summary")
    has_kw = any(k in prompt for k in kw)
    has_in = any(r.startswith("input/") for r in rels)
    has_out = any(r.startswith("output/") for r in rels)
    return has_kw and has_in and has_out

async def _run_summarize_task(project_id: str, prompt: str) -> Dict[str, Any]:
    mani = load_manifest(project_id)
    project_root = mani["_project_root"]
    write_dir = mani.get("write_dir", "output")

    # 1) メンション抽出 → 相対パスへ
    raw_mentions = _extract_mentions(prompt)
    rels = [_resolve_rel(project_root, mani, r) for r in raw_mentions]

    input_rel: Optional[str] = next((r for r in rels if r.startswith("input/")), None)
    guide_rel: Optional[str] = next((r for r in rels if r.startswith("guideline/")), None)
    out_rel: Optional[str]   = next((r for r in rels if r.startswith(f"{write_dir}/")), None)
    if not input_rel or not out_rel:
        raise HTTPException(400, "summarize task requires @input/... and @output/... mentions")

    # 2) 入力・ガイドライン読み込み
    input_abs = os.path.join(project_root, input_rel)
    if not os.path.isfile(input_abs):
        raise HTTPException(404, f"not a file: @{input_rel}")
    src_text = _read_text_safe(input_abs)

    guide_text = None
    if guide_rel:
        guide_abs = os.path.join(project_root, guide_rel)
        if not os.path.isfile(guide_abs):
            raise HTTPException(404, f"not a file: @{guide_rel}")
        guide_text = _read_text_safe(guide_abs)

    # 3) 出力先（ディレクトリ指定なら自動命名）
    out_is_dir = out_rel.endswith("/") or os.path.isdir(os.path.join(project_root, out_rel))
    if out_is_dir:
        stem = pathlib.Path(input_rel).stem or "summary"
        out_rel = f"{write_dir}/{stem}-summary.md"
    if not out_rel.startswith(f"{write_dir}/"):
        raise HTTPException(403, f"write must be under @{write_dir}: got @{out_rel}")
    out_abs = os.path.join(project_root, out_rel)

    # 4) プロンプト合成 → 要約生成（ツールなし）
    sys = (
        "あなたは日本語のドキュメント要約アシスタントです。"
        "入力テキストを簡潔にMarkdownで要約してください。"
        "見出し/箇条書きを適宜使い、余計な前置きは書かないでください。"
    )
    parts = [
        "### 入力テキスト",
        "```text",
        src_text,
        "```",
    ]
    if guide_text:
        parts += ["### ガイドライン", "```text", guide_text, "```"]
    parts += ["### 要求", "上記を要約し、Markdown本文のみを出力してください。"]
    composed = sys + "\n\n" + "\n".join(parts)

    md = await _llm_complete_text(composed)

    # 5) 保存
    _ensure_parent_dir(out_abs)
    with open(out_abs, "w", encoding="utf-8") as f:
        f.write(md)

    return {
        "text": f"✅ DONE: @{out_rel}\n\n（Files からプレビューできます）",
        "meta": {
            "task": "summarize",
            "project_id": project_id,
            "input": f"@{input_rel}",
            "guideline": (f"@{guide_rel}" if guide_rel else None),
            "output": f"@{out_rel}",
        }
    }

# ========== /ask：B案に自動分岐＋フォールバックでツール実行 ==========
@app.post("/ask")
async def ask(body: AskBody):
    m = load_manifest(body.project_id)

    # ---- まずは B案（要約→保存）を判定 ----
    mentions = _extract_mentions(body.prompt)
    try:
        rels = [_resolve_rel(m["_project_root"], m, r) for r in mentions]
    except HTTPException:
        rels = []
    if _looks_like_summarize(body.prompt, rels):
        return await _run_summarize_task(body.project_id, body.prompt)

    # ---- フォールバック：ツール実行エージェント（止まり対策: 自動承認ON）----
    system_prompt = (
        "You are a careful coding assistant working inside a team project.\n"
        "Rules:\n"
        f"- Operate strictly under the project root: {m['_project_root']}\n"
        f"- Read-only dirs: {', '.join(m.get('read_dirs', []))}\n"
        f"- Write dir: {m.get('write_dir','output')}\n"
        "- Prefer using Read/Write with explicit relative paths and show concrete paths you touched.\n"
        "- If you create files, put them under the write dir.\n"
    )

    options = ClaudeCodeOptions(
        system_prompt=system_prompt,
        max_turns=8,
        allowed_tools=["Read", "Write", "Bash"],
        cwd=m["_write_dir_abs"],
        add_dirs=m["_read_dirs_abs"],
        permission_mode="acceptEdits",  # SDKが対応していれば自動承認
    )

    prompt = (
        body.prompt
        + build_alias_hint(m)
        + "\n\nPlease actually perform Read/Write operations and end your answer with:\n"
          "DONE: <@path or relative path> when you have finished."
    )

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

            return {"text": "".join(chunks), "meta": meta}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
