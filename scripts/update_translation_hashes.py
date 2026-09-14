#!/usr/bin/env python3
"""Retired compatibility entrypoint: English is now an immutable backup."""

from __future__ import annotations

import sys


def main() -> int:
    print(
        "已停用：中文是唯一执行源，英文是固定历史备份，不再刷新翻译哈希。"
        "请运行 python scripts/validate.py 检查文档与备份完整性。",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
