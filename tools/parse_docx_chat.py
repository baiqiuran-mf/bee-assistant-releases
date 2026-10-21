# -*- coding: utf-8 -*-
"""
把「客户聊天记录（Matrix Tool 本机）」导出的 .docx 解析成消息列表 JSON。

导出格式（每个消息三条信息）：
    [13:55] 客户          <- 时间 + 方向（客户=in / 我方=out）
    I have add you now.   <- 原文（英文）
    我已经加上你了。        <- 中文对照（有才写）

    [13:55] 客户
    [图片未缓存到本机]      <- 图片占位

也支持日期分隔行：2026-09-18

用法：
    python tools/parse_docx_chat.py <输入.docx> <输出.json>
输出 JSON：{ "title":..., "phone":..., "messages":[ {date,time,direction,body,body_zh} ] }
"""
import io
import json
import re
import sys
import zipfile


def dump_docx_paragraphs(path):
    z = zipfile.ZipFile(path)
    xml = z.read('word/document.xml').decode('utf-8', 'ignore')
    paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.S)
    out = []
    for para in paras:
        texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', para, re.S)
        line = ''.join(texts)
        for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'),
                     ('&quot;', '"'), ('&apos;', "'")):
            line = line.replace(a, b)
        out.append(line)
    return out


DATE_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})$')
HEAD_RE = re.compile(r'^\[(\d{1,2}:\d{2})\]\s*(客户|我方)\s*$')
CJK_RE = re.compile(r'[\u4e00-\u9fff]')
IMG_PLACEHOLDER_RE = re.compile(r'图片未缓存|预览，点开原图后会替换|^\s*$')


def parse(path):
    lines = dump_docx_paragraphs(path)

    meta = {}
    msgs = []
    cur = None
    cur_date = None

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue

        m = re.match(r'^(标题|昵称|电话|Chat ID|WA 用户名|锁客 ID|操作员工|更新时间)[:：]\s*(.*)$', line)
        if m and cur is None:
            meta[m.group(1)] = m.group(2).strip()
            continue

        d = DATE_RE.match(line.strip())
        if d:
            cur_date = line.strip()
            continue

        h = HEAD_RE.match(line.strip())
        if h:
            if cur:
                msgs.append(cur)
            cur = {
                'date': cur_date,
                'time': h.group(1),
                'direction': 'in' if h.group(2) == '客户' else 'out',
                'lines': [],
            }
            continue

        if cur is not None:
            cur['lines'].append(line)

    if cur:
        msgs.append(cur)

    # ---- 把 lines 拆成 原文 / 中文对照 ----
    out = []
    for m in msgs:
        body_lines = [x.strip() for x in m['lines'] if not IMG_PLACEHOLDER_RE.search(x)]
        is_image = len(body_lines) == 0 and len(m['lines']) > 0

        body, body_zh = '', ''
        if is_image:
            body = '[图片]'
        elif body_lines:
            latin = [x for x in body_lines if not CJK_RE.search(x)]
            cjk = [x for x in body_lines if CJK_RE.search(x)]
            if latin and cjk:
                body, body_zh = ' '.join(latin), ' '.join(cjk)
            else:
                body = ' '.join(body_lines)

        out.append({
            'date': m['date'],
            'time': m['time'],
            'direction': m['direction'],
            'body': body,
            'body_zh': body_zh,
        })

    return {'meta': meta, 'messages': out}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    data = parse(src)
    with io.open(dst, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    msgs = data['messages']
    ins = sum(1 for m in msgs if m['direction'] == 'in')
    print('解析完成：%d 条（客户 %d / 我方 %d）→ %s' % (len(msgs), ins, len(msgs) - ins, dst))
    print('meta:', json.dumps(data['meta'], ensure_ascii=False))
    for m in msgs[:5]:
        print('  ', m['date'], m['time'], m['direction'], '|', m['body'][:60], '||', m['body_zh'][:40])
    print('   ...')
    for m in msgs[-5:]:
        print('  ', m['date'], m['time'], m['direction'], '|', m['body'][:60], '||', m['body_zh'][:40])


if __name__ == '__main__':
    main()
