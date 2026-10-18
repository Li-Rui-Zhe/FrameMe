"""FrameMe: an upload-based image and animation workbench."""
from __future__ import annotations

import io
import hashlib
import json
import math
import os
import re
import shutil
import threading
import time
import uuid
import warnings
import zipfile
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, render_template, request, send_file, session, url_for
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import HTTPException
from tools.image_pipeline import fit_frames, remove_color, split_image
from tools.workspace_store import SQLiteWorkspaceStore

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FRAMELAB_DATA_DIR", BASE_DIR / ".runtime" / "jobs")).resolve()
WORKSPACE_STORE = SQLiteWorkspaceStore(BASE_DIR / ".runtime" / "workspaces" / "workspaces.sqlite3")
MAX_FRAMES = 128
MAX_PIXELS = 24_000_000
PROCESSING_SLOTS = threading.BoundedSemaphore(2)
app = Flask(__name__, template_folder=str(BASE_DIR / "web"), static_folder=str(BASE_DIR / "web" / "static"))
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024
app.config.update(SESSION_COOKIE_NAME="framelab_session", SESSION_COOKIE_HTTPONLY=True,
                  SESSION_COOKIE_SAMESITE="Lax", PERMANENT_SESSION_LIFETIME=timedelta(days=3650), SESSION_REFRESH_EACH_REQUEST=False)


def session_secret():
    configured = os.environ.get("FRAMELAB_SESSION_SECRET")
    if configured:
        return configured
    key_path = BASE_DIR / ".runtime" / "session.key"
    key_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with key_path.open("xb") as stream:
            stream.write(os.urandom(32))
    except FileExistsError:
        pass
    return key_path.read_bytes()


app.secret_key = session_secret()


def integer(options, key, default, low, high):
    value = options.get(key, default)
    try:
        parsed = int(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"{key} 必须是整数") from None
    if isinstance(value, bool) or str(value).strip() != str(parsed):
        raise ValueError(f"{key} 必须是整数")
    value = parsed
    if not low <= value <= high:
        raise ValueError(f"{key} 必须在 {low}–{high} 之间")
    return value


def validate_options(options):
    if not isinstance(options, dict):
        raise ValueError("处理参数必须是对象")
    mode, layout = options.get("mode", "split"), options.get("layout", "horizontal")
    if mode not in {"split", "cutout", "rename"}:
        raise ValueError("未知的处理方式")
    options = dict(options)
    if mode != "split":
        options.update(frames=1, rows=1, columns=1, bounds=[], layout="horizontal")
        layout = "horizontal"
    if mode == "rename":
        options.update(size=0, padding=0, ratio=80, tolerance=18, feather=8, color="#33ff00", align=False, trim=False)
    if layout not in {"horizontal", "vertical", "grid"}:
        raise ValueError("未知的切帧布局")
    prefix = str(options.get("prefix", "frame")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", prefix):
        raise ValueError("文件名前缀需为 1–48 位英文字母、数字、下划线或连字符")
    color = options.get("color", "#33ff00")
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ValueError("请选择有效的背景颜色")
    result = {
        "mode": mode, "layout": layout, "prefix": prefix,
        "frames": integer(options, "frames", 6, 1, MAX_FRAMES),
        "rows": integer(options, "rows", 2, 1, 32),
        "columns": integer(options, "columns", 3, 1, 32),
        "size": integer(options, "size", 0, 0, 1024),
        "padding": integer(options, "padding", 16, 0, 128),
        "ratio": integer(options, "ratio", 80, 10, 100),
        "tolerance": integer(options, "tolerance", 18, 0, 100),
        "feather": integer(options, "feather", 8, 0, 40),
        "color": color,
        "auto_color": options.get("auto_color", True) is True,
        "remove_bg": mode == "cutout" or options.get("remove_bg", False) is True,
        "align": options.get("align", False) is True,
        "trim": options.get("trim", False) is True,
        "bounds": options.get("bounds", []),
    }
    if mode == "split" and layout == "grid" and result["rows"] * result["columns"] > MAX_FRAMES:
        raise ValueError("单张图片最多切割 128 帧")
    if result["size"] and result["padding"] * 2 >= result["size"]:
        raise ValueError("留白需要小于画布尺寸的一半")
    if not isinstance(result["bounds"], list) or len(result["bounds"]) >= MAX_FRAMES:
        raise ValueError("裁剪线参数无效")
    if mode == "rename":
        result.update(remove_bg=False, size=0, align=False, trim=False)
    return result


def cleanup_jobs():
    # Complete results are permanent. Failure handlers clean their own outputs;
    # only old incomplete directories left by a crash are swept here.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for directory in DATA_DIR.iterdir():
        if (directory.is_dir() and not directory.is_symlink() and re.fullmatch(r"[a-f0-9]{32}", directory.name)
                and directory.resolve().parent == DATA_DIR.resolve() and not (directory / "manifest.json").exists()
                and directory.stat().st_mtime < time.time() - 86400):
            shutil.rmtree(directory)


def load_job(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise FileNotFoundError("任务不存在或已被删除")
    directory = DATA_DIR / job_id
    manifest = directory / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError("任务文件不存在或已被删除")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if not session.get("owner") or data.get("owner") != session["owner"]:
        raise FileNotFoundError("任务不存在或不属于当前会话")
    return directory, data


def public_job(manifest):
    job_id = manifest["id"]
    groups = []
    for index, group in enumerate(manifest["groups"]):
        groups.append({
            "name": group["name"], "source_size": group["source_size"],
            "source_url": url_for("job_source", job_id=job_id, group=index),
            "frames": [{**frame, "url": url_for("job_frame", job_id=job_id, filename=frame["filename"])} for frame in group["frames"]],
        })
    return {
        "ok": True, "id": job_id, "created_at": manifest["created_at"],
        "expires_at": None,
        "groups": groups, "frame_count": sum(len(g["frames"]) for g in groups),
        "options": manifest["options"], "warnings": manifest["warnings"],
        "zip_url": url_for("job_export", job_id=job_id, kind="zip"),
        "folders_zip_url": url_for("job_export", job_id=job_id, kind="folders"),
        "sheet_url": url_for("job_export", job_id=job_id, kind="sheet"),
        "gif_url": url_for("job_export", job_id=job_id, kind="gif"),
        "retouched": bool(manifest.get("retouched")),
    }


@app.before_request
def same_origin():
    if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc.lower() != request.host.lower():
            return jsonify(ok=False, error="请从工作台页面发起请求"), 403
    if request.path in {"/", "/editor", "/about", "/prompts", "/api/process"} and not session.get("owner"):
        session["owner"] = uuid.uuid4().hex
    if session.get("owner") and not session.permanent:
        session.permanent = True


@app.after_request
def response_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    if request.path in {"/", "/editor", "/about", "/prompts"} or request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index():
    return editor()


@app.get("/editor")
def editor():
    scope = hashlib.sha256(("framelab-drafts:" + session["owner"]).encode()).hexdigest()
    return render_template("index.html", workspace_scope=scope)


@app.get("/about")
def about():
    scope = hashlib.sha256(("framelab-drafts:" + session["owner"]).encode()).hexdigest()
    return render_template("about.html", workspace_scope=scope)


@app.get("/prompts")
def prompts():
    scope = hashlib.sha256(("framelab-drafts:" + session["owner"]).encode()).hexdigest()
    return render_template("prompts.html", workspace_scope=scope)


@app.get("/api/health")
def health():
    return jsonify(ok=True, name="FrameMe", version="3.0.0")


def workspace_identity(tab, draft_id=None):
    if not session.get("owner") or not re.fullmatch(r"[a-f0-9]{32}", tab):
        raise FileNotFoundError("工作区不存在或不属于当前会话")
    if draft_id is not None and not re.fullmatch(r"[a-f0-9]{32}", draft_id):
        raise FileNotFoundError("原图草稿不存在")
    return session["owner"]


@app.route("/api/workspaces/<tab>/jobs", methods=["GET", "POST", "DELETE"])
def workspace_jobs(tab):
    owner = workspace_identity(tab)
    if request.method in {"POST", "DELETE"}:
        payload = request.get_json(silent=True)
        ids = payload.get("ids") if isinstance(payload, dict) else None
        if not isinstance(ids, list) or not 1 <= len(ids) <= 128 or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value) for value in ids):
            raise ValueError("请选择 1–128 个有效任务")
        ids = list(dict.fromkeys(ids))
        # Authorize the entire batch before mutating any task.
        jobs = [(job_id, *load_job(job_id)) for job_id in ids]
        if request.method == "POST":
            WORKSPACE_STORE.register_jobs(owner, tab, ids)
            return jsonify(ok=True)
        deleted, failed = [], []
        for job_id, directory, _ in jobs:
            # Check the resolved target before any recursive deletion. Never
            # follow a link or delete outside this project's configured job root.
            if directory.is_symlink() or directory.resolve().parent != DATA_DIR.resolve():
                raise ValueError("任务目录无效")
        for job_id, directory, _ in jobs:
            try:
                shutil.rmtree(directory)
                deleted.append(job_id)
            except OSError:
                failed.append(job_id)
        WORKSPACE_STORE.forget_jobs(owner, deleted)
        return jsonify(ok=True, deleted=deleted, failed=failed)
    scope = request.args.get("scope", "tab")
    if scope not in {"tab", "all"}:
        raise ValueError("任务范围无效")
    mapping = WORKSPACE_STORE.job_tabs(owner)
    rows = []
    for directory in DATA_DIR.iterdir() if DATA_DIR.exists() else []:
        if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r"[a-f0-9]{32}", directory.name):
            continue
        try:
            raw = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
            if raw.get('owner') != owner:
                continue
            job_tab = raw.get('tab') or mapping.get(directory.name)
            if scope == 'tab' and job_tab != tab:
                continue
            frame = raw['groups'][0]['frames'][0]
            size = sum(path.stat().st_size for path in directory.iterdir() if path.is_file() and not path.is_symlink())
            rows.append(dict(id=directory.name, name=raw['groups'][0]['name'], count=sum(len(group['frames']) for group in raw['groups']),
                             created_at=raw['created_at'], mode=raw['options']['mode'], bytes=size,
                             thumbnail=url_for('job_frame', job_id=directory.name, filename=frame['filename']),
                             current_workspace=job_tab == tab))
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            continue
    rows.sort(key=lambda row: row['created_at'], reverse=True)
    return jsonify(ok=True, jobs=rows, bytes=sum(row['bytes'] for row in rows),
                   draft_bytes=WORKSPACE_STORE.draft_bytes(owner, tab if scope == 'tab' else None), retention="permanent")


@app.route("/api/workspaces/<tab>/state", methods=["GET", "POST"])
def workspace_state(tab):
    owner = workspace_identity(tab)
    if request.method == "GET":
        return jsonify(ok=True, state=WORKSPACE_STORE.state(owner, tab))
    if request.content_length is None or request.content_length > 64 * 1024:
        raise ValueError("工作区参数过大")
    data = request.get_json(silent=True)
    scope = hashlib.sha256(("framelab-drafts:" + owner).encode()).hexdigest()
    if not isinstance(data, dict) or data.get("schema") != 1 or data.get("tab") != tab or data.get("scope") != scope:
        raise ValueError("工作区参数无效")
    stamp = data.get("savedAt")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp) or not 0 < stamp <= time.time() * 1000 + 60_000:
        raise ValueError("工作区保存时间无效")
    if data.get("activeTool") not in {"split", "cutout", "rename", "history"} or not isinstance(data.get("workspaces"), dict):
        raise ValueError("工作区参数无效")
    if set(data["workspaces"]) - {"split", "cutout", "rename"} or any(not isinstance(value, dict) for value in data["workspaces"].values()):
        raise ValueError("工作区参数无效")
    WORKSPACE_STORE.save_state(owner, tab, data)
    return jsonify(ok=True)


@app.post("/api/workspaces/<tab>/files")
def workspace_files_upload(tab):
    owner = workspace_identity(tab)
    uploads = request.files.getlist("files")
    if not 1 <= len(uploads) <= 12:
        raise ValueError("原图草稿需包含 1–12 张图片")
    modified = json.loads(request.form.get("last_modified", "[]"))
    if not isinstance(modified, list) or len(modified) != len(uploads) or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in modified):
        raise ValueError("原图信息无效")
    stored, total_bytes = [], 0
    for upload, last_modified in zip(uploads, modified):
        content = upload.read()
        total_bytes += len(content)
        if total_bytes > 40 * 1024 * 1024:
            raise ValueError("原图总大小不能超过 40 MB")
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > MAX_PIXELS:
                    raise ValueError("原图需为 PNG、JPG 或 WebP，且不能超过 2400 万像素")
                mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[image.format]
                image.verify()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, SyntaxError):
            raise ValueError("原图文件损坏或格式不受支持") from None
        name = (upload.filename or "image.png").replace("\\", "/").rsplit("/", 1)[-1]
        if not name or len(name) > 255:
            raise ValueError("原图文件名无效")
        stored.append(dict(name=name, mime=mime, last_modified=last_modified, content=content))
    draft_id = WORKSPACE_STORE.put_files(owner, tab, stored)
    return jsonify(ok=True, id=draft_id), 201


@app.route("/api/workspaces/<tab>/files/<draft_id>", methods=["GET", "DELETE"])
def workspace_files(tab, draft_id):
    owner = workspace_identity(tab, draft_id)
    if request.method == "DELETE":
        WORKSPACE_STORE.remove_files(owner, tab, draft_id)
        return jsonify(ok=True)
    files = WORKSPACE_STORE.files(owner, tab, draft_id)
    for item in files:
        item["url"] = url_for("workspace_file", tab=tab, draft_id=draft_id, position=item["position"])
    return jsonify(ok=True, files=files)


@app.get("/api/workspaces/<tab>/files/<draft_id>/<int:position>")
def workspace_file(tab, draft_id, position):
    owner = workspace_identity(tab, draft_id)
    name, mime, content = WORKSPACE_STORE.file(owner, tab, draft_id, position)
    return send_file(io.BytesIO(content), mimetype=mime, download_name=name)


@app.post("/api/process")
def process():
    directory = None
    if not PROCESSING_SLOTS.acquire(blocking=False):
        return jsonify(ok=False, error="当前正在处理其他任务，请稍后重试"), 429
    try:
        options = validate_options(json.loads(request.form.get("options", "{}")))
        uploads = [f for f in request.files.getlist("files") if f.filename]
        if not uploads or len(uploads) > 12:
            raise ValueError("请上传 1–12 张图片")
        if options["bounds"] and len(uploads) != 1:
            raise ValueError("手动裁剪线仅适用于单张图片")
        cleanup_jobs()
        job_id = uuid.uuid4().hex
        directory = DATA_DIR / job_id
        directory.mkdir()
        groups, messages = [], []
        input_pixels = output_pixels = count = 0
        for group_index, upload in enumerate(uploads):
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(upload.stream) as raw:
                    if raw.format not in {"PNG", "JPEG", "WEBP"}:
                        raise ValueError("仅支持 PNG、JPG 和 WebP 图片")
                    input_pixels += raw.width * raw.height
                    if input_pixels > MAX_PIXELS:
                        raise ValueError("一次处理的原图总像素不能超过 2400 万，请缩小图片或分批上传")
                    source = ImageOps.exif_transpose(raw).convert("RGBA")
            source.save(directory / f"source_{group_index}.png")
            processed = remove_color(source, options) if options["remove_bg"] else source
            panels = split_image(processed, options) if options["mode"] == "split" else [processed]
            count += len(panels)
            if count > MAX_FRAMES:
                raise ValueError("一次处理的输出总帧数不能超过 128")
            output_pixels += sum(options["size"] ** 2 if options["size"] else panel.width * panel.height for panel in panels)
            if output_pixels > MAX_PIXELS:
                raise ValueError("输出总像素不能超过 2400 万，请减少帧数或降低输出尺寸")
            frames = fit_frames(panels, options)
            records = []
            for frame_index, frame in enumerate(frames):
                suffix = f"_{group_index + 1:02d}" if len(uploads) > 1 and options["mode"] != "rename" else ""
                number = group_index + 1 if options["mode"] == "rename" else frame_index + 1
                filename = f"{options['prefix']}{suffix}_{number:04d}.png"
                frame.save(directory / filename)
                records.append({"filename": filename, "width": frame.width, "height": frame.height})
            if options["remove_bg"] and processed.getchannel("A").getextrema() == (0, 0):
                messages.append(f"{Path(upload.filename).name}：处理后图片完全透明，请检查背景颜色或容差")
            groups.append({"name": Path(upload.filename.replace("\\", "/")).name[:160], "source_size": list(source.size), "frames": records})
        tab = request.form.get("tab")
        if tab is not None and not re.fullmatch(r"[a-f0-9]{32}", tab):
            raise ValueError("工作区标识无效")
        manifest = {"id": job_id, "owner": session["owner"], "tab": tab, "created_at": time.time(), "options": options, "groups": groups, "warnings": messages}
        (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        return jsonify(public_job(manifest)), 201
    except (ValueError, TypeError, KeyError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        if directory:
            shutil.rmtree(directory, ignore_errors=True)
        message = "无法识别图片，请检查文件是否完整" if isinstance(exc, UnidentifiedImageError) else str(exc)
        return jsonify(ok=False, error=message), 400
    except HTTPException:
        if directory:
            shutil.rmtree(directory, ignore_errors=True)
        raise
    except Exception:
        if directory:
            shutil.rmtree(directory, ignore_errors=True)
        app.logger.exception("Image processing failed")
        return jsonify(ok=False, error="图片处理失败，请检查素材或稍后重试"), 500
    finally:
        PROCESSING_SLOTS.release()


@app.get("/api/jobs/<job_id>")
def job_info(job_id):
    directory, manifest = load_job(job_id)
    return jsonify(public_job(manifest))


@app.get("/api/jobs/<job_id>/source/<int:group>")
def job_source(job_id, group):
    directory, manifest = load_job(job_id)
    if group >= len(manifest["groups"]):
        raise FileNotFoundError("原图不存在")
    return send_file(directory / f"source_{group}.png", mimetype="image/png")


@app.get("/api/jobs/<job_id>/frames/<filename>")
def job_frame(job_id, filename):
    directory, manifest = load_job(job_id)
    allowed = {f["filename"] for g in manifest["groups"] for f in g["frames"]}
    if filename not in allowed:
        raise FileNotFoundError("图片不存在")
    return send_file(directory / filename, mimetype="image/png", as_attachment=request.args.get("download") == "1", download_name=filename)


@app.get("/api/jobs/<job_id>/retouch-base/<int:group>")
def retouch_base(job_id, group):
    directory, manifest = load_job(job_id)
    if manifest["options"]["mode"] != "cutout" or group >= len(manifest["groups"]):
        raise FileNotFoundError("可修补的素材不存在")
    with Image.open(directory / f"source_{group}.png") as raw:
        source = raw.convert("RGBA")
    processed = remove_color(source, manifest["options"])
    reference = fit_frames([processed], manifest["options"], reference_frames=[source])[0]
    buffer = io.BytesIO()
    reference.save(buffer, format="PNG")
    buffer.seek(0)
    return send_file(buffer, mimetype="image/png")


@app.post("/api/jobs/<job_id>/retouch")
def retouch_job(job_id):
    source_dir, manifest = load_job(job_id)
    if manifest["options"]["mode"] != "cutout":
        raise ValueError("手动修补仅用于背景移除结果")
    if not PROCESSING_SLOTS.acquire(blocking=False):
        return jsonify(ok=False, error="当前正在处理其他任务，请稍后重试"), 429
    directory = None
    try:
        group = integer(request.form, "group", 0, 0, len(manifest["groups"]) - 1)
        record = manifest["groups"][group]["frames"][0]
        upload = request.files.get("image")
        if not upload:
            raise ValueError("请提交修补后的 PNG 图片")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(upload.stream) as raw:
                if raw.format != "PNG" or raw.size != (record["width"], record["height"]):
                    raise ValueError("修补图片必须为相同尺寸的 PNG")
                if raw.width * raw.height > MAX_PIXELS:
                    raise ValueError("修补图片不能超过 2400 万像素")
                edited = raw.convert("RGBA")
        # Save a new job revision. Other tabs and the original history result
        # continue to reference their own immutable files.
        new_id = uuid.uuid4().hex
        directory = DATA_DIR / new_id
        shutil.copytree(source_dir, directory)
        edited.save(directory / record["filename"], format="PNG")
        tab = request.form.get("tab", manifest.get("tab"))
        if tab is not None and not re.fullmatch(r"[a-f0-9]{32}", tab):
            raise ValueError("工作区标识无效")
        manifest.update(id=new_id, created_at=time.time(), retouched=True, tab=tab)
        (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        return jsonify(public_job(manifest)), 201
    except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        if directory:
            shutil.rmtree(directory, ignore_errors=True)
        raise ValueError("无法读取修补图片，请提交有效 PNG")
    except Exception:
        if directory:
            shutil.rmtree(directory, ignore_errors=True)
        raise
    finally:
        PROCESSING_SLOTS.release()


@app.get("/api/jobs/<job_id>/export/<kind>")
def job_export(job_id, kind):
    directory, manifest = load_job(job_id)
    records = [f for g in manifest["groups"] for f in g["frames"]]
    prefix = manifest["options"]["prefix"]
    buffer = io.BytesIO()
    if kind in {"zip", "folders"}:
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for group_index, group in enumerate(manifest["groups"]):
                folder = prefix if len(manifest["groups"]) == 1 or manifest["options"]["mode"] == "rename" else f"{prefix}_{group_index + 1:02d}"
                for frame in group["frames"]:
                    archive_name = f"{folder}/{frame['filename']}" if kind == "folders" else frame["filename"]
                    archive.write(directory / frame["filename"], arcname=archive_name)
            archive.writestr("frames.json", json.dumps({"generator": "FrameMe 3.0", "options": manifest["options"], "groups": manifest["groups"]}, ensure_ascii=False, indent=2))
        suffix = "folders" if kind == "folders" else "frames"
        mimetype, filename = "application/zip", f"{prefix}_{suffix}.zip"
    elif kind == "sheet":
        columns = min(8, math.ceil(math.sqrt(len(records))))
        cell_w, cell_h = max(f["width"] for f in records), max(f["height"] for f in records)
        width, height = columns * cell_w, math.ceil(len(records) / columns) * cell_h
        if width * height > MAX_PIXELS or max(width, height) > 16384:
            raise ValueError("合并后图片过大，请降低输出尺寸")
        sheet = Image.new("RGBA", (width, height))
        for index, frame in enumerate(records):
            with Image.open(directory / frame["filename"]) as image:
                sheet.alpha_composite(image, (index % columns * cell_w + (cell_w - image.width) // 2, index // columns * cell_h + (cell_h - image.height) // 2))
        sheet.save(buffer, format="PNG")
        mimetype, filename = "image/png", f"{prefix}_sheet.png"
    elif kind == "gif":
        fps = integer(request.args, "fps", 12, 1, 30)
        group = integer(request.args, "group", 0, 0, len(manifest["groups"]) - 1)
        sequence = manifest["groups"][group]["frames"]
        width, height = max(f["width"] for f in sequence), max(f["height"] for f in sequence)
        if width * height * len(sequence) > MAX_PIXELS:
            raise ValueError("动画过大，请降低输出尺寸")
        gif_frames = []
        for frame in sequence:
            with Image.open(directory / frame["filename"]) as image:
                canvas = Image.new("RGBA", (width, height))
                canvas.alpha_composite(image, ((width - image.width) // 2, (height - image.height) // 2))
                palette = canvas.convert("RGB").quantize(colors=255, dither=Image.Dither.NONE)
                palette.putpalette((palette.getpalette() + [0] * 768)[:765] + [0, 0, 0])
                palette.paste(255, mask=canvas.getchannel("A").point(lambda a: 255 if a < 128 else 0))
                palette.info["transparency"] = 255
                gif_frames.append(palette)
        gif_frames[0].save(buffer, format="GIF", save_all=True, append_images=gif_frames[1:], loop=0, duration=round(1000 / fps / 10) * 10, transparency=255, disposal=2, optimize=False)
        mimetype, filename = "image/gif", f"{prefix}_{group + 1:02d}.gif"
    else:
        raise FileNotFoundError("导出格式不存在")
    buffer.seek(0)
    return send_file(buffer, mimetype=mimetype, as_attachment=True, download_name=filename)


@app.errorhandler(FileNotFoundError)
def missing_job(exc):
    return jsonify(ok=False, error=str(exc)), 404


@app.errorhandler(ValueError)
def invalid_request(exc):
    return jsonify(ok=False, error=str(exc)), 400


@app.errorhandler(413)
def too_large(exc):
    return jsonify(ok=False, error="上传总大小不能超过 40 MB，请分批处理"), 413


if __name__ == "__main__":
    print("FrameMe 3.0 · http://127.0.0.1:7860", flush=True)
    cleanup_jobs()
    app.run(host="127.0.0.1", port=7860, debug=False)
