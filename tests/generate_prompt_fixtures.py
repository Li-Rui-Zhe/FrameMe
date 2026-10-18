from pathlib import Path
from PIL import Image
out=Path('.runtime/prompt-evidence'); out.mkdir(parents=True,exist_ok=True)
strip=Image.new('RGBA',(3072,512),'#33ff00')
for i,p in enumerate(sorted(Path('web/static/examples/bytepet/frames').glob('calm_*.png'))):
    frame=Image.new('RGBA',(512,512),'#33ff00')
    frame.alpha_composite(Image.open(p).convert('RGBA'))
    frame.save(out/f'input_{i+1:04d}.png')
    strip.alpha_composite(frame,(i*512,0))
strip.save(out/'input-strip.png')
