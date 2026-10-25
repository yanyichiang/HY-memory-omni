"""Rebuild with fontTools 4.62.1; python subset.py upstream.ttf output-directory.
Upstream and license are pinned in SOURCE.md. Runs offline after obtaining input.
"""
import json, pathlib, sys
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib.instancer import instantiateVariableFont

source, destination = sys.argv[1:]
out = pathlib.Path(destination)
out.mkdir(parents=True, exist_ok=True)
# All GB2312 characters, Latin blocks, general/CJK punctuation, symbols and kana.
gb2312 = set()
characters = set(range(0x20, 0x250)) | set(range(0x2000, 0x2070)) | set(range(0x2100, 0x2200)) | set(range(0x3000, 0x3100)) | set(range(0xFF00, 0xFFF0))
for high in range(0xA1, 0xF8):
    for low in range(0xA1, 0xFF):
        try: gb2312.add(ord(bytes([high, low]).decode('gb2312')))
        except (UnicodeDecodeError, TypeError): pass
characters |= gb2312
coverage = None
for style, weight in [('Regular', 400), ('Bold', 700)]:
    font = TTFont(source, recalcTimestamp=False)
    # Subset before instancing keeps generation CPU and memory bounded.
    options = subset.Options()
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=characters)
    sub.subset(font)
    font = instantiateVariableFont(font, {'wght': weight}, inplace=True)
    for record in font['name'].names:
        values = {1: 'HY Office Sans SC', 2: style, 3: f'HY-Office-Sans-SC-2.004-{style}', 4: f'HY Office Sans SC {style}', 6: f'HYOfficeSansSC-{style}', 16: 'HY Office Sans SC', 17: style}
        if record.nameID in values:
            record.string = values[record.nameID].encode(record.getEncoding())
    font.save(out / f'HYOfficeSansSC-{style}.ttf')
    points = sorted(font.getBestCmap())
    if coverage is not None and coverage != points: raise RuntimeError('style cmap differs')
    coverage = points
(out / 'coverage.json').write_text(json.dumps(coverage, separators=(',', ':')) + '\n')
print(json.dumps({'codePoints': len(coverage), 'GB2312Missing': sorted(gb2312 - set(coverage)), 'bytes': {p.name: p.stat().st_size for p in out.glob('*.ttf')}}))
