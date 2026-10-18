"""Append the verified FrameMe identity and UI refresh to the user's report."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import shutil
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / '.runtime/brand-evidence'
START, END = '<!-- frameme-brand-update:start -->', '<!-- frameme-brand-update:end -->'


def verify_example():
    with zipfile.ZipFile(EVIDENCE / 'frameme-example.zip') as archive:
        assert archive.testzip() is None
        assert json.loads(archive.read('frames.json'))['generator'] == 'FrameMe 3.0'
        for index in range(1, 7):
            with Image.open(io.BytesIO(archive.read(f'calm_{index:04d}.png'))) as result, Image.open(ROOT / f'web/static/examples/bytepet/frames/calm_{index:04d}.png') as source:
                assert result.size == source.size == (512, 512)
                assert result.convert('RGBA').tobytes() == source.convert('RGBA').tobytes()


def append(report):
    sources = {
        'brand': EVIDENCE / 'brand-results.json',
        'backend': ROOT / '.runtime/test-evidence/backend-results.json',
        'browser': ROOT / '.runtime/test-evidence/browser-results.json',
        'refresh': ROOT / '.runtime/refresh-evidence/refresh-results.json',
        'isolation': ROOT / '.runtime/session-evidence/isolation-results.json',
        'upload': ROOT / '.runtime/upload-evidence/upload-results.json',
    }
    results = {name: json.loads(path.read_text(encoding='utf-8')) for name, path in sources.items()}
    for name, expected in [('brand', 7), ('backend', 59), ('browser', 34), ('refresh', 14), ('isolation', 16), ('upload', 15)]:
        assert results[name]['passed'] == expected and results[name]['failed'] == 0, name
    assert results['backend']['errors'] == 0
    verify_example()
    now = datetime.now(timezone(timedelta(hours=8)))
    destination = report.parent / '附件' / now.strftime('帧的么-品牌与界面-%Y%m%d-%H%M%S')
    destination.mkdir(parents=True, exist_ok=True)
    for source in sources.values():
        shutil.copyfile(source, destination / source.name)
    for name in ['frameme-light.png', 'frameme-dark.png', 'frameme-mobile.png', 'frameme-result.png', 'frameme-example.zip']:
        shutil.copyfile(EVIDENCE / name, destination / name)
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [
        'web/index.html', 'web/static/app.css', 'web/static/app.js', 'web/static/draft-store.js', 'web/static/favicon.svg',
    ]}
    (destination / 'implementation-hashes.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    relative = destination.relative_to(report.parent).as_posix()
    lines = [START, f'## {now:%Y-%m-%d %H:%M} 更新：帧的么 FrameMe 品牌与界面', '',
        '**项目名称：帧的么 · FrameMe。** “帧”对应图片、序列帧与动画，“屿”对应一处整理素材和灵感的创作空间。品牌文案为“为下一次创作，准备好每一帧。”继续面向游戏动画、贴纸、插画、图标与产品动效。', '',
        '### 本次界面调整', '',
        '- 深海蓝导航、纸白画布、创作蓝主操作与薄荷绿插画；浅色和深色主题均重新整理。',
        '- 使用三张错位画布与小星组成的原生 SVG 标志，统一页面标题、侧栏、图标、启动信息和导出文件元信息。',
        '- 画布优先布局；放大关键文字与控件，统一圆角、间距、步骤、选中态、上传区、参数面板及下载面板。',
        '- 手机显示三个工具的完整名称；检查 1920、1440、1024、768、760、390、320px，无横向溢出。',
        '- 顶部显示真实保存状态：正在保存、工作区已保存、保存失败。通过模拟失败和恢复连接验证反馈及刷新恢复。',
        '- 主要文字在浅色/深色下分别检查 7 处，均达到 4.5:1 对比度；键盘 Tab 焦点可见。此为选定关键区域检查，不代表完整 WCAG 认证。',
        '- 导出用语改为“全部素材 ZIP”“分组目录 ZIP”，适用于通用素材工作流；BytePet 原始案例图片及像素保持一致。',
        '- SQLite 数据库、签名 Cookie、标签页标识、历史键与存储作用域保持兼容，没有因品牌更新清空已有工作区。', '',
        '**验证结果：59 项后端检查通过；86 项浏览器检查通过（品牌/界面 7、功能 34、刷新 14、隔离 16、上传 15）。** 新品牌示例 ZIP 的 CRC、生成器名称及 6/6 帧完整 RGBA 像素校验通过。', '',
        '| 编号 | 场景 | 结果 |', '| --- | --- | --- |']
    for row in results['brand']['results']:
        lines.append(f"| {row['id']} | {row['name']} | {row['status']} |")
    lines += ['', '### 实际页面', '',
        f'![帧的么浅色工作台]({relative}/frameme-light.png)', '',
        f'![帧的么深色工作台]({relative}/frameme-dark.png)', '',
        f'![帧的么手机工作台]({relative}/frameme-mobile.png)', '',
        f'![帧的么一键生成结果]({relative}/frameme-result.png)', '',
        '### 验证记录', '',
        f'- [品牌与界面检查]({relative}/brand-results.json)',
        f'- [后端检查]({relative}/backend-results.json)',
        f'- [原有功能检查]({relative}/browser-results.json)',
        f'- [刷新恢复]({relative}/refresh-results.json)',
        f'- [隔离检查]({relative}/isolation-results.json)',
        f'- [上传检查]({relative}/upload-results.json)',
        f'- [新品牌实际下载 ZIP]({relative}/frameme-example.zip)', '',
        '新增脚本：`tests/browser_brand_ui.cjs`。品牌与色彩说明：项目 `docs/brand.md`。', '', END, '']
    text = report.read_text(encoding='utf-8').replace('# FrameLab 动画与图片素材工作台测试报告\n', '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n', 1)
    if START in text:
        start, end = text.index(START), text.index(END) + len(END)
        text = text[:start] + text[end:].lstrip('\n')
    heading = '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n'
    assert heading in text
    report.write_text(text.replace(heading, heading + '\n' + '\n'.join(lines) + '\n', 1), encoding='utf-8')
    print('FrameMe report verified: 59 backend, 86 browser, example ZIP pixels preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    append(parser.parse_args().report)
