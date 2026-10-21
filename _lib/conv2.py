import re, sys, os

def tables_to_md(s):
    def repl(m):
        block = m.group(0)
        rows = re.findall(r'<TableRow[^>]*>(.*?)</TableRow>', block, re.S)
        out = []
        for ri, row in enumerate(rows):
            cells = re.findall(r'<TableCell[^>]*>(.*?)</TableCell>', row, re.S)
            vals = []
            for c in cells:
                t = re.sub(r'<[^>]+>', '', c)
                t = t.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
                vals.append(' '.join(t.split()))
            out.append('| ' + ' | '.join(vals) + ' |')
            if ri == 0:
                out.append('|' + '---|' * len(vals))
        return '\n' + '\n'.join(out) + '\n'
    return re.sub(r'<Table[^>]*>.*?</Table>', repl, s, flags=re.S)

def conv(path):
    s = open(path, encoding="utf-8").read()
    s = re.sub(r'^---\ntitle:.*?\n---\n', '', s, flags=re.S)
    s = re.sub(r'KS_DOC_REVIEWS.*$', '', s, flags=re.M)
    s = s.replace('\r\n', '\n')
    s = tables_to_md(s)

    s = re.sub(r'<Heading id="[^"]*" level="(\d)">\s*', lambda m: '#' * int(m.group(1)) + ' ', s)
    s = re.sub(r'</Heading>', '', s)
    s = re.sub(r'<Paragraph id="[^"]*">', '', s)
    s = re.sub(r'</Paragraph>', '', s)
    s = re.sub(r'<ListItem id="[^"]*">', '', s)
    s = re.sub(r'</ListItem>', '', s)
    s = re.sub(r'<BlockQuote id="[^"]*">', '', s)
    s = re.sub(r'</BlockQuote>', '', s)
    s = re.sub(r'<Divider id="[^"]*"\s*/?>', '---', s)
    s = re.sub(r'<(Mark|Code|CodeLine|Callout|Mermaid|Image)\b[^>]*>', '', s)
    s = re.sub(r'</(Mark|Code|CodeLine|Callout|Mermaid|Image)>', '', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = s.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').replace('&quot;', '"')

    # 合并：每行记录缩进状态，缩进行并入上一个非空行
    lines = s.split('\n')
    out = []
    for ln in lines:
        stripped = ln.strip()
        if not stripped:
            out.append('')
            continue
        indented = ln[:1].isspace() or ln.startswith(' ')
        if indented and out and out[-1] and not out[-1].startswith('|'):
            out[-1] = out[-1] + ' ' + stripped
        else:
            out.append(stripped)
    res = []
    for ln in out:
        res.append(ln)
    txt = '\n'.join(res)
    txt = re.sub(r'\\([^\n])', r'\1', txt)
    txt = re.sub(r'\n{3,}', '\n\n', txt)
    return txt.strip() + '\n'

for p in sys.argv[1:]:
    dst = sys.argv[-1]
    break

base = "E:/WorkBuddy-Projects/wa-assistant/knowledge"
os.makedirs(base, exist_ok=True)
mapping = {
    "persona.xml": "persona.md",
    "stories.xml": "stories.md",
    "products.xml": "products.md",
    "redlines.xml": "redlines.md",
    "templates.xml": "templates.md",
    "README.xml": "../README.md",
}
for src, dst in mapping.items():
    t = conv(os.path.join("E:/WorkBuddy-Projects/wa-assistant/_lib", src))
    open(os.path.join(base, dst), "w", encoding="utf-8").write(t)
    print(dst, len(t))
