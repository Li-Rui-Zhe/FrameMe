"""Check real downloaded files, original asset integrity and safe sprite margins."""
from pathlib import Path
import hashlib
import io
import json
import zipfile
from PIL import Image

root=Path(__file__).resolve().parents[1]
assets=root/'web/static/examples/bytepet'
out=root/'.runtime/quality-evidence'
catalog=json.loads((assets/'example.json').read_text(encoding='utf-8'))
results=[]
def check(name, action):
    action()
    results.append({'name':name,'status':'PASS'})

def original_integrity():
    for entry in catalog['states']:
        paths=entry.get('original_frame_files',entry['frame_files'])
        assert [hashlib.sha256((assets/p).read_bytes()).hexdigest() for p in paths]==entry['sha256']
check('16张BytePet原始帧的SHA256保持不变',original_integrity)
happy=next(e for e in catalog['states'] if e['key']=='happy')
def repaired_frames():
    assert happy['source_kind']=='repaired'
    assert [hashlib.sha256((assets/p).read_bytes()).hexdigest() for p in happy['frame_files']]==happy['derived_sha256']
    for path in happy['frame_files']:
        with Image.open(assets/path) as image:
            assert image.size==(512,512) and image.mode=='RGBA'
            box=image.getchannel('A').point(lambda a:255 if a>128 else 0).getbbox()
            assert box and box[0]>=20 and box[1]>=20 and box[2]<=492 and box[3]<=492
            # The topmost 30 pixels must contain a visible cyan antenna ball.
            pixels=list(image.crop((box[0],box[1],box[2],box[1]+30)).getdata())
            assert sum(1 for r,g,b,a in pixels if a>128 and b>120 and g>120 and b>r+15)>30
check('优化版六帧有完整天线、透明背景与安全留白',repaired_frames)
def consistent_assets():
    with Image.open(assets/happy['strip']) as strip,Image.open(assets/happy['thumbnail']) as thumbnail:
        assert strip.size==(3072,512)
        assert strip.crop((0,0,512,512)).tobytes()==thumbnail.tobytes()
        for i,path in enumerate(happy['frame_files']):
            with Image.open(assets/path) as frame:
                assert strip.crop((512*i,0,512*(i+1),512)).tobytes()==frame.tobytes()
check('长条、独立PNG与缩略图像素一致',consistent_assets)
def downloaded_png():
    with Image.open(out/'happy.png') as actual,Image.open(assets/happy['frame_files'][0]) as expected:
        assert actual.convert('RGBA').tobytes()==expected.tobytes()
check('浏览器PNG下载保留优化版像素',downloaded_png)
def downloaded_gif():
    with Image.open(out/'happy.gif') as image:
        assert image.format=='GIF' and image.n_frames==6 and image.size==(512,512)
        assert image.info['loop']==0
check('GIF包含六帧完整角色并循环播放',downloaded_gif)
def downloaded_zip(filename):
    with zipfile.ZipFile(out/filename) as archive:
        assert archive.testzip() is None
        files=sorted(p for p in archive.namelist() if p.endswith('.png'))
        assert len(files)==6
        for name,path in zip(files,happy['frame_files']):
            with Image.open(io.BytesIO(archive.read(name))) as actual,Image.open(assets/path) as expected:
                assert actual.convert('RGBA').tobytes()==expected.tobytes()
check('逐帧ZIP下载包含六张一致的完整角色PNG',lambda:downloaded_zip('happy.zip'))
check('批量命名ZIP使用同一组完整角色PNG',lambda:downloaded_zip('happy-renamed.zip'))
(out/'artifact-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS: 7 artifact and source integrity checks')
