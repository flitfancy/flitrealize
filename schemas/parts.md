# 器件资料数据约定

请求、取得状态与共享缓存的现有说明集中在本页。命令、资料取得与库存分工见[工具参考](../docs/technical/parts-data-tools.md)。

## 资料请求

输入包含 `parts` 数组，每项至少提供 `lcsc` 或 `mpn`，可补充已知制造商和关键词：

```json
{
  "parts": [
    {
      "lcsc": "C536262",
      "manufacturer": "Infineon",
      "mpn": "IM69D130V01",
      "keywords": ["PDM", "4x3mm"]
    }
  ]
}
```

## 请求路径

`--input` 和可选 `--output` 使用项目根目录内的相对路径。默认结果清单为 `parts/DATASHEET_MANIFEST.json`。已知数据手册地址时，在条目提供 `mpn` 和 HTTPS `url`。

## 取得结果

| 每项 `result` | 含义 |
| --- | --- |
| `local` | 命中可用本地资料 |
| `downloaded` | 取得并保存资料 |
| `needs_lookup` | 需要补充查询或数据手册 URL |
| `error` | 获取／保存失败，或已知身份冲突、候选身份有歧义 |

结果清单保留取得状态、来源与文件路径。这些是资料取得结果；是否采用器件仍按 1.2 的当前要求判断。

## 共享缓存文件

共享资料库由 `--database-root` 指定，目录中每个器件保存 `part.json` 和 `datasheet.pdf`，例如：

```text
parts-database/
├── C470965/
│   ├── part.json
│   └── datasheet.pdf
└── MPN_TPS25221DBVR/
    ├── part.json
    └── datasheet.pdf
```
