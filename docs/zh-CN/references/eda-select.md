> 本文件是英文参考文件 [eda-select.md](../../../references/eda-select.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-31（Asia/Shanghai）
> 英文源文件 SHA-256：`CD227F52BD8DBD876CA7203B55A5B01C5F54851254D146403694AD1A7019434E`

# EDA Provider 选择

只有用户要求 EDA 工作或 Provider 专属制品时才读取本参考。可移植需求、器件决策和原理图意图不需要 EDA Provider。

## 不遍历全部 Provider 的选择方法

1. 用户已经指定 EDA 时，在该 Provider 已实现的前提下直接使用。
2. 当前项目已经存在权威 EDA 源文件时，继续使用该 Provider，除非用户要求迁移。
3. 用户只要求可移植设计或采购输出时，在进入 EDA 前停止。
4. 用户要求 EDA 工作但没有指定或现有 Provider 时，查询已注册 Provider。只有一个已启用且受支持的 Provider 时直接使用；多个合理选择会实质改变结果时才询问用户。

选定后只读取该 Provider 的入口和当前操作对应流程。按当前 domain 查询已注册的公共 Action，不遍历实现脚本。

## 已实现 Provider

- EasyEDA Pro：[easyeda-pro.md](easyeda-pro.md)

真实 Adapter、能力探测、已实现 Action、测试覆盖和有边界的实机检查点尚未存在时，不创建占位 Provider 目录，也不声称已经支持。
