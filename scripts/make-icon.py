from pathlib import Path
from PIL import Image, ImageDraw

project_root = Path(__file__).resolve().parents[1]
folder = project_root / 'src' / 'assets'
folder.mkdir(parents=True, exist_ok=True)
image = Image.new('RGBA', (256, 256), (18, 22, 26, 255))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((4, 4, 251, 251), radius=54, fill=(23, 28, 32), outline=(122, 95, 56), width=3)
color = (242, 183, 96)
draw.line([(82, 57), (56, 57), (56, 199), (82, 199)], fill=color, width=12, joint='curve')
draw.line([(174, 57), (200, 57), (200, 199), (174, 199)], fill=color, width=12, joint='curve')
draw.ellipse((115, 84, 141, 110), fill=color)
draw.ellipse((115, 147, 141, 173), fill=color)
image.save(folder / 'icon.png')
image.save(folder / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Application icon created.')
