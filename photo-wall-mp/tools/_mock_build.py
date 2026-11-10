import base64, io, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(HERE, '_mock_bg.jpg')
tpl = os.path.join(HERE, '_mock_template.html')
out = os.path.join(HERE, '_mock.html')

im = Image.open(src).convert('RGB')
im = im.resize((im.width * 4, im.height * 4), Image.LANCZOS)
buf = io.BytesIO()
im.save(buf, 'JPEG', quality=88)
b64 = base64.b64encode(buf.getvalue()).decode()

html = open(tpl, encoding='utf-8').read().replace('__BG64__', 'data:image/jpeg;base64,' + b64)
open(out, 'w', encoding='utf-8').write(html)
print('ok', out, len(html), im.size)
