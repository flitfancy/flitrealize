# 器件资料工具参考

调用资料解析器或接入已有库存汇总工具时读本页。选型、资料判断和交给原理图的条件见 [1.2](../1.2-parts.md)；器件身份及封装字段以 [Contract](schematic-contract.md#器件)为准。

## 资料解析器

[parts-resolver.mjs](../../scripts/parts/parts-resolver.mjs) 查询、取得和缓存器件资料，保存来源与本地文件信息。它不读取用户库存、不生成库存 CSV，也不绑定 EDA 元件库。

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

```text
node <skill>/scripts/parts/parts-resolver.mjs --project-root <project> --database-root <parts-database> --input <项目相对输入文件>
```

`--input` 和可选 `--output` 使用项目根目录内的相对路径。默认结果清单为 `parts/DATASHEET_MANIFEST.json`。已知数据手册地址时，在条目提供 `mpn` 和 HTTPS `url`。

解析器先查本地记录。需要下载时使用条目中的数据手册 URL，或按 LCSC 编号读取产品页资料链接。只有 MPN 而无可用缓存或 URL 时返回 `needs_lookup`，由调用者补查。来源编号失效、身份或资料缺失时，按制造商、MPN 和关键词核对，再把确认的 URL 交回工具保存。

| 每项 `result` | 含义 |
| --- | --- |
| `local` | 命中可用本地资料 |
| `downloaded` | 取得并保存资料 |
| `needs_lookup` | 需要补充查询或数据手册 URL |
| `error` | 获取／保存失败，或已知身份冲突、候选身份有歧义 |

结果清单保留取得状态、来源与文件路径。这些是资料取得结果；是否采用器件仍按 1.2 的当前要求判断。

## 本地资料库与缓存

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

本地命中时返回路径，不访问网络。解析器比对输入与记录中均已提供的 MPN、制造商字段，检查 PDF 文件及已有校验值；字段冲突和身份歧义返回具体问题。同一身份的多份缓存可复用，存储名冲突不会覆盖另一器件资料。

缓存缺失时按当前支持来源取得资料并保存。共享资料库供项目复用，项目采用的器件、封装与理由仍由当前主文稿和 Contract 保存；不自动打开库中全部 PDF。

## 与库存工具衔接

源库存记录用户实际拥有的物料，须由用户已有工具读取。没有适用工具时保留查询或汇总缺口；本 Skill 没有内置库存数据库或工作簿读取器。

已有生成器需要面向 AI 的只读库存汇总时，可以加入资料是否存在、资料目录、当前准确型号和最近取得来源。这些是可选衍生字段，不要求用户在库存工作簿中手工维护，也不把资料缓存当作数量或可用状态。

新资料取得后，本次任务可以立即使用返回路径。之后由已有生成器重新汇总时再纳入最新资料状态，解析器本身不自动刷新库存 CSV。
