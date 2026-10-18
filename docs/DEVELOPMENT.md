# FrameMe 开发、接口与存储说明

[返回项目首页](../README.md)

## 运行

需要 Python 3.10 或更新版本。依赖只有 Flask 和 Pillow，无需 Node.js、打包器或外部服务。

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

打开 http://127.0.0.1:7860 。Windows 也可先双击 `install.bat`，再双击 `start.bat`。

## 功能

- 横向、纵向、网格切割；单图长条支持拖动裁剪线或输入精确坐标。
- 批量处理 PNG、JPG、WebP，最多 12 张，总上传大小不超过 40 MB。
- 自动识别或手动选择纯色背景，调整颜色容差、边缘柔化；支持从原图取色。
- 保留原始尺寸，或输出 128 / 256 / 512 / 1024 像素画布。
- 使用同一缩放比例对齐一个动画序列，保持姿态之间的相对大小。
- 批量命名与 PNG 格式统一，不修改原文件。
- 动画播放、逐帧查看、4–30 FPS 速度调整、透明 / 白色 / 深色预览背景。
- 下载单帧 PNG、序列帧 ZIP（包含 JSON 元信息）、精灵图与循环 GIF。
- 浏览器内最近任务、浅色与深色主题、手机布局、键盘操作。
- 内置 BytePet 项目案例：平静待机、向右跑保留原始帧，开心使用补全天线并整理轮廓的优化演示版；原始开心素材与校验值另行保留。可直接载入、预览并导出动作目录，运行时无需访问 GitHub。
- 保留浏览器 Canvas 原创示例作为案例加载失败时的备用预览。
- 背景移除使用原工具保存的真实绿幕上传素材；批量命名使用独立 PNG（开心为同一优化版），载入演示保持当前工具。

BytePet 案例的具体操作、来源与导入要求见 [使用示例](docs/examples/bytepet.md)。它只提供单个动作，替换已有完整角色对应动作时保持 512×512 尺寸。

纯色背景移除使用颜色匹配，不是 AI 人像或复杂场景分割。相近主体颜色也可能被移除，请先查看结果、调整容差。GIF 不支持 PNG 那样的半透明边缘。

## 文件与任务

原始素材目录 `assets/` 不会被工作台改写。每次处理结果独立存放在 `.runtime/jobs/<随机任务ID>/`。可通过环境变量 `FRAMELAB_DATA_DIR` 指定其他目录；Windows 可将其设到 D 盘。

原图、参数和处理结果默认长期保存，不会自动过期。最近任务从本地文件读取，显示任务文件与导入草稿占用，支持确认后单项或批量删除（每次最多 128 项）。默认只显示当前工作区；主动选择“此浏览器的所有工作区”可找回关闭标签页中的结果，打开时恢复原图副本与参数继续处理。列表不再限制最近 12 个任务。一次任务输入与输出各限制 2400 万像素，总输出不超过 128 帧，同时最多处理两个任务。

原始图片草稿和工作区状态存储在当前项目的 **`.runtime/workspaces/workspaces.sqlite3`** 中，使用 Python 自带的 SQLite，无需安装数据库服务。图片以原始字节保存，状态包括各工具的参数、裁剪线、当前素材、预览帧和处理结果引用。刷新页面和服务重启后会恢复当前工作区。导出的 PNG/ZIP/GIF 仍存放在 `.runtime/jobs/`。

三个工具与各个标签页分别保存，草稿接口同时验证浏览器身份及标签页标识；新标签页不会自动加载别的标签页的原图。浏览器只保留标签页标识、历史缓存和待提交状态副本，原图不再存入 IndexedDB。Cookie 使用长期身份，使同一浏览器关闭重开后仍能主动查找旧工作区结果；Cookie 丢失或更换浏览器不会认领旧身份的数据。磁盘占用中的“任务文件”统计原图副本、处理结果和元信息，“导入草稿”统计该身份的 SQLite 图片数据，不含数据库预留空间。

升级后旧数据库中尚未物理清除的草稿和状态会改为长期保存；仍在磁盘中的旧任务不再受旧过期时间限制。已经被旧版清理的文件无法恢复。完整任务不会自动清理，只有处理失败产生的残缺目录在超过一天后清理；新处理失败也会立即清理其临时输出。删除历史任务会移除其任务目录，清除工作区对该结果的引用；当前导入草稿和已导出到其他目录的文件保留。

API 不接受用户指定的服务器文件路径。所有任务元信息、原图、帧文件与导出均校验浏览器会话归属；知道任务 ID 也不能读取其他会话的数据。会话使用签名的 HttpOnly / SameSite=Lax Cookie，签名密钥默认保存在忽略的 `.runtime/session.key`，可通过 `FRAMELAB_SESSION_SECRET` 配置。旧的无归属任务不会被新会话认领。当前默认绑定 `127.0.0.1`，只供本机访问。

示例可点“一键试用”直接生成并下载。默认保留原图尺寸，高级设置默认收起。导出区直接选择格式后点击下载：序列帧默认 GIF，背景移除默认当前图片 PNG，批量命名默认 PNG 逐帧图片 ZIP；也可选择分组 ZIP 或精灵图 PNG。GIF 导出当前选中的素材序列，速度跟随预览 FPS；ZIP 包含全部帧。GIF 不保留半透明边缘，PNG 保留透明细节。格式选择按工具分别保存，刷新可恢复。批量命名仅整理独立图片，不提供 GIF 合成。会话签名密钥仅供服务端使用，不应提交到仓库。

试用后首次上传自己的图片会替换示例素材、清除旧结果，并自动回到新图片的原图预览。示例专用参数恢复为工具默认值（切帧从 1 帧开始，请按自己的素材设置帧数）。继续上传自己的图片则追加到当前列表，并显示新上传的图片；点击素材名称可切换原图。任务处理或示例加载期间收到的图片会暂存，结束后自动导入。

## API

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 服务状态 |
| `GET /api/workspaces/<tab>/jobs?scope=tab` | 当前工作区任务、文件占用；`scope=all` 显式查看同一浏览器身份的所有工作区 |
| `POST /api/workspaces/<tab>/jobs` | JSON `ids`：迁移旧版本的任务历史引用，仅允许本身份任务 |
| `DELETE /api/workspaces/<tab>/jobs` | JSON `ids`：确认后删除 1–128 个任务，全批先验证归属 |
| `POST /api/process` | multipart：`files` 可重复，`options` 是 JSON 字符串 |
| `GET /api/jobs/<id>` | 结果元信息 |
| `GET /api/jobs/<id>/source/<group>` | 原图 |
| `GET /api/jobs/<id>/frames/<filename>` | 单帧；`?download=1` 下载 |
| `GET /api/jobs/<id>/retouch-base/<group>` | 与处理结果相同尺寸和坐标的原始内容，用于恢复画笔 |
| `POST /api/jobs/<id>/retouch` | multipart：`group` 与同尺寸 PNG `image`，生成新的修补任务版本，仅支持背景移除 |
| `GET /api/jobs/<id>/export/zip` | 全部帧与 JSON |
| `GET /api/jobs/<id>/export/folders` | 按文件前缀分目录的 ZIP |
| `GET /api/jobs/<id>/export/sheet` | 全部帧合成精灵图 |
| `GET /api/jobs/<id>/export/gif?fps=12&group=0` | 当前素材组 GIF |

基本处理参数：

```json
{
  "mode": "split",
  "layout": "horizontal",
  "frames": 6,
  "size": 256,
  "prefix": "frame",
  "remove_bg": false,
  "align": false
}
```

`mode` 支持 `split / cutout / rename`；`layout` 支持 `horizontal / vertical / grid`。网格使用 `rows` 与 `columns`；手动裁剪使用递增整数数组 `bounds`。完整默认值见 `app.py:validate_options`。

## 检查

```bash
python -m unittest discover -s tests -v
```

## 部署

保留 Flask + Pillow 即可部署，前端由同一服务提供，不需要构建。公开服务应使用正式 WSGI 服务器与 HTTPS，而非 `python app.py` 的开发服务器。例如安装 Waitress 后：

```bash
python -m pip install waitress
waitress-serve --host=127.0.0.1 --port=7860 app:app
```

由反向代理提供公开域名和 HTTPS，并按服务器资源增加访问频率与磁盘配额控制。当前提供浏览器身份隔离和本机长期存储，不提供账号系统或跨浏览器同步；丢失身份 Cookie 后不能通过任务链接找回旧身份的数据。

## 项目结构

```text
app.py                          HTTP 接口、任务存储、导出
tools/image_pipeline.py         通用 Pillow 图像处理
tools/workspace_store.py        SQLite 原图草稿与工作区状态
tools/split_cutout_6frame_strip.py 原有命令行工具，继续保留
web/index.html                  工作台页面
web/static/app.css              响应式主题
web/static/app.js               上传、预览、裁剪与下载
web/static/draft-store.js       工作区持久化与标签页隔离
tests/                          图像与 API 验证
```
