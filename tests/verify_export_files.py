from pathlib import Path
from PIL import Image, ImageSequence
import zipfile, io, json

out=Path('.runtime/export-evidence')
results=[]
def check(name, action):
    action()
    results.append({'name':name,'status':'PASS'})
def gif(file,duration):
    with Image.open(out/file) as image:
        assert image.format=='GIF' and image.n_frames==6
        assert image.info['loop']==0
        for frame in ImageSequence.Iterator(image):
            assert frame.info['duration']==duration
def png(file,size=None,transparent=False):
    with Image.open(out/file) as image:
        assert image.format=='PNG'
        image.load()
        if size: assert image.size==size, image.size
        if transparent:
            low,high=image.convert('RGBA').getchannel('A').getextrema()
            assert low==0 and high==255,(low,high)
def archive(file,count,folders=False):
    with zipfile.ZipFile(out/file) as archive:
        assert archive.testzip() is None
        names=[name for name in archive.namelist() if name.endswith('.png')]
        assert len(names)==count,(file,names)
        if folders: assert all('/' in name for name in names)
        for name in names:
            with Image.open(io.BytesIO(archive.read(name))) as image:
                assert image.format=='PNG'; image.load()
check('GIF 六帧循环、4 FPS（250ms/帧）',lambda:gif('animation.gif',250))
check('GIF 调速为 8 FPS（GIF 精度量化为120ms/帧）',lambda:gif('animation-8fps.gif',120))
check('当前帧 PNG 尺寸与透明通道',lambda:png('frame.png',(512,512),True))
check('精灵图 PNG 可解码且保留透明通道',lambda:png('sheet.png',transparent=True))
check('全部帧 ZIP 包含六张可解码 PNG',lambda:archive('frames.zip',6))
check('分组 ZIP 保留子目录及六张 PNG',lambda:archive('folders.zip',6,True))
check('免费去底 PNG 含完全透明及不透明像素',lambda:png('cutout.png',transparent=True))
check('失败重试后的 PNG 可用',lambda:png('cutout-retry.png',transparent=True))
check('批量命名 ZIP 包含六张 PNG',lambda:archive('renamed.zip',6))
(out/'file-verification.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))
