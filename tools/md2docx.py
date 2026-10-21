#!/usr/bin/env python3
"""把蜜蜂信息采集_使用说明书.md 转成同名的 .docx（保持标题层级 + 代码块 + 引用 + 列表）。

用法（受管 Python）：
  python tools/md2docx.py
生成：蜜蜂信息采集_使用说明书.docx（覆盖同名文件）
"""
import re
import os
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "蜜蜂信息采集_使用说明书.md")
DST = os.path.join(ROOT, "蜜蜂信息采集_使用说明书.docx")

CODE_BG = RGBColor(0x33, 0x33, 0x33)


def split_blocks(lines):
    """把 md 行切成块：heading / code / quote / list / para。"""
    blocks = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.startswith("```"):
            buf = []
            i += 1
            while i < n and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # 跳过结束的 ```
            blocks.append(("code", buf))
            continue
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            text = line.lstrip("#").strip()
            blocks.append(("h", (level, text)))
            i += 1
            continue
        if line.startswith(">"):
            buf = []
            while i < n and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip())
                i += 1
            blocks.append(("quote", buf))
            continue
        if re.match(r"^\s*[-*]\s+", line):
            buf = []
            while i < n and re.match(r"^\s*[-*]\s+", lines[i]):
                buf.append(re.sub(r"^\s*[-*]\s+", "", lines[i]))
                i += 1
            blocks.append(("list", buf))
            continue
        if line.strip() == "":
            i += 1
            continue
        # 普通段落：合并连续非空、非特殊行
        buf = [line]
        i += 1
        while i < n and lines[i].strip() != "" and not lines[i].startswith(("#", "```", ">", "-", "*")):
            buf.append(lines[i])
            i += 1
        blocks.append(("p", buf))
    return blocks


def strip_inline(text):
    """去掉行内标记（粗体、行内代码），返回纯文本。"""
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    return text.strip()


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        lines = f.read().split("\n")

    doc = Document()
    # 默认字体（中文用等线/宋体回退）
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)

    for kind, payload in split_blocks(lines):
        if kind == "h":
            level, text = payload
            h = doc.add_heading(strip_inline(text), level=min(level, 3))
            continue
        if kind == "code":
            para = doc.add_paragraph()
            run = para.add_run("\n".join(payload))
            run.font.name = "Consolas"
            run.font.size = Pt(10)
            run.font.color.rgb = RGBColor(0x1a, 0x1a, 0x1a)
            para.paragraph_format.left_indent = Pt(12)
            continue
        if kind == "quote":
            para = doc.add_paragraph()
            run = para.add_run("\n".join(payload))
            run.italic = True
            run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
            para.paragraph_format.left_indent = Pt(14)
            continue
        if kind == "list":
            for item in payload:
                doc.add_paragraph(strip_inline(item), style="List Bullet")
            continue
        # para
        text = " ".join(strip_inline(x) for x in payload)
        if text.strip():
            doc.add_paragraph(text)

    doc.save(DST)
    print("已生成:", DST, os.path.getsize(DST), "字节")


if __name__ == "__main__":
    main()
