"""Record SQLite persistence, refresh isolation and actual service restart QA."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / '.runtime/refresh-evidence'
START, END = '<!-- framelab-sqlite-update:start -->', '<!-- framelab-sqlite-update:end -->'


def verify_storage():
    database = ROOT / '.runtime/workspaces/workspaces.sqlite3'
    connection = sqlite3.connect(database)
    try:
        assert connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert connection.execute('PRAGMA foreign_key_check').fetchall() == []
        counts = {table: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                  for table in ['drafts', 'draft_files', 'workspaces']}
        assert all(counts.values())
    finally:
        connection.close()
    with Image.open(EVIDENCE / 'restored-cutout.png') as image:
        assert image.size == (256, 256)
        rgba = image.convert('RGBA')
        assert all(rgba.getpixel(point)[3] == 0 for point in [(0, 0), (255, 0), (0, 255), (255, 255)])
        assert rgba.getpixel((128, 128))[3] > 0
    checks = dict(sqlite_path=database.relative_to(ROOT).as_posix(), integrity='ok', foreign_key_violations=0,
                  rows=counts, restored_download='256×256 PNG，四角透明且主体中心保留')
    (EVIDENCE / 'sqlite-audit.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')


def append(report):
    sources = {
        'backend': ROOT / '.runtime/test-evidence/backend-results.json',
        'refresh': EVIDENCE / 'refresh-results.json',
        'upload': ROOT / '.runtime/upload-evidence/upload-results.json',
        'isolation': ROOT / '.runtime/session-evidence/isolation-results.json',
        'browser': ROOT / '.runtime/test-evidence/browser-results.json',
    }
    results = {key: json.loads(path.read_text(encoding='utf-8')) for key, path in sources.items()}
    for key, expected in [('backend', 59), ('refresh', 14), ('upload', 15), ('isolation', 16), ('browser', 34)]:
        assert results[key]['failed'] == 0 and results[key]['passed'] == expected, key
    assert results['backend']['errors'] == 0
    restart = json.loads((EVIDENCE / 'restart-results.json').read_text(encoding='utf-8'))
    assert restart['status'] == 'PASS'
    verify_storage()
    now = datetime.now(timezone(timedelta(hours=8)))
    destination = report.parent / '附件' / now.strftime('FrameMe-SQLite刷新恢复-%Y%m%d-%H%M%S')
    destination.mkdir(parents=True, exist_ok=True)
    for source in sources.values():
        shutil.copyfile(source, destination / source.name)
    for name in ['restart-results.json', 'sqlite-audit.json', 'browser-environment.json', 'restored-cutout.png',
                 'unprocessed-after-refresh.png', 'processed-after-refresh.png', 'mobile-after-refresh.png']:
        shutil.copyfile(EVIDENCE / name, destination / name)
    shutil.copyfile(ROOT / '.runtime/test-evidence/backend-tests.log', destination / 'backend-tests.log')
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [
        'app.py', 'tools/workspace_store.py', 'web/static/draft-store.js', 'web/static/app.js', 'web/index.html',
    ]}
    (destination / 'implementation-hashes.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    relative = destination.relative_to(report.parent).as_posix()
    lines = [START, f'## {now:%Y-%m-%d %H:%M} 更新：项目内 SQLite 存储与刷新恢复', '',
        '此前只保存任务历史引用，当前原图、参数和预览仍在页面内存中，刷新会重新初始化为 BytePet 示例；之前的刷新检查漏测了当前工作区恢复。本次按用户要求改为项目内 SQLite 持久化。', '',
        '**当前存储位置：** 项目目录 `.runtime/workspaces/workspaces.sqlite3`，现有工作区位于 D 盘。使用 Python 标准库 sqlite3，无需安装数据库服务。', '',
        '- `drafts` 保存会话、标签页及有效期；`draft_files` 以 BLOB 保存原始图片字节、名称、类型与修改时间；`workspaces` 保存各工具参数、裁剪线、选中素材、预览帧、任务引用及当前工具。',
        '- 原图不再存入 IndexedDB。浏览器保留标签页标识、最近任务引用，以及服务器提交完成前的短暂状态副本；清除这份临时副本后仍能从 SQLite 恢复。',
        '- 刷新时先恢复自己的工作区，再加载示例入口。未处理原图能继续生成；已完成任务可继续预览和下载；参数已修改时仍禁用旧结果下载。',
        '- 每个工具独立保存；草稿原图接口同时验证浏览器会话和标签页标识。新标签页及 window.open 复制的 sessionStorage 都不会混入原标签页的草稿。',
        '- SQLite 使用事务与 WAL；写入原图后再提交状态引用。迟到的旧状态请求不能覆盖更新的状态。过期记录及其图片行会清理。',
        '- 原图草稿和工作区状态默认有效期 24 小时；生成的 PNG/ZIP/GIF 继续位于 `.runtime/jobs/` 并遵循任务原有 24 小时有效期。服务重启后，在同一有效浏览器会话/标签页中可以恢复。',
        '- Cookie 丢失后不会恢复旧身份数据；关闭标签页或清空其存储后不保证自动找回原标签页。更新前已因刷新丢失、且从未存入服务器的未处理图片，无法补回，需要重新上传一次。', '',
        '**复测结果：59 项后端检查、79 项浏览器检查（刷新 14 / 上传 15 / 隔离 16 / 原有功能 34）全部通过；真实服务重启恢复检查通过。** 新增后端检查包含 12 项 SQLite 字节完整性、权限、事务、过期清理、重开数据库和旧请求保护，以及 2 项浏览器身份作用域/缓存检查。', '',
        '并行试跑四个浏览器时曾触发本地两个同时处理任务的上限（429）；按该限制单独执行后，34 项功能回归全部通过。', '',
        '| 编号 | 场景 | 结果 |', '| --- | --- | --- |']
    for row in results['refresh']['results'] + [restart]:
        lines.append(f"| {row['id']} | {row['name']} | {row['status']} |")
    lines += ['', 'SQLite 实库 `integrity_check=ok`，外键检查零异常；刷新后直接下载的 PNG 为 256×256，四角透明、主体保留。检查报告只复制测试记录与受控截图，不复制包含原图的实际数据库。', '',
        '### 刷新后的界面', '',
        f'![未处理原图、参数及高级设置在刷新后恢复]({relative}/unprocessed-after-refresh.png)', '',
        f'![处理结果与直接下载在刷新后恢复]({relative}/processed-after-refresh.png)', '',
        f'![手机刷新恢复自己的图片]({relative}/mobile-after-refresh.png)', '',
        '### 当前证据', '',
        f'- [59 项后端结果]({relative}/backend-results.json)',
        f'- [后端运行日志]({relative}/backend-tests.log)',
        f'- [14 项刷新回归]({relative}/refresh-results.json)',
        f'- [15 项上传回归]({relative}/upload-results.json)',
        f'- [16 项隔离回归]({relative}/isolation-results.json)',
        f'- [34 项功能回归]({relative}/browser-results.json)',
        f'- [真实服务重启结果]({relative}/restart-results.json)',
        f'- [SQLite 完整性与恢复下载核验]({relative}/sqlite-audit.json)',
        f'- [刷新后实际下载的 PNG]({relative}/restored-cutout.png)', '',
        '复现：`tests/browser_refresh.cjs`；服务重启检查：`tests/browser_restart.cjs`。后者在原图和参数写入 SQLite 后清除浏览器待提交副本、保持浏览器打开并实际重启本地 app.py，随后刷新并验证可继续生成。', '', END, '']
    text = report.read_text(encoding='utf-8').replace('# FrameLab 动画与图片素材工作台测试报告\n', '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n', 1)
    if START in text:
        start, end = text.index(START), text.index(END) + len(END)
        text = text[:start] + text[end:].lstrip('\n')
    heading = '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n'
    assert heading in text
    report.write_text(text.replace(heading, heading + '\n' + '\n'.join(lines) + '\n', 1), encoding='utf-8')
    print('SQLite audit and report complete: 59 backend, 79 browser, 1 real server restart.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    append(parser.parse_args().report)
