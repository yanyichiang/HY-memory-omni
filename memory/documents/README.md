# 原生文档证据解析

`parseDocument(mimeType, bytes)` 返回独立 `original`、有序 `units` 与总 `coverage`。每单位包含 `locator`、有界 `context`、原生 `images`、相关 `coverage`，PDF 另有单页 `derived` bytes。`Uint8Array` 可直接由存储层保存；API 传输应明确编码，不把整批 bytes 展开成 JSON 数字对象。无网络读取、模型调用、排版服务或公式重算。公开 MIME 列表为 `DOCUMENT_MIME_TYPES`。

依赖由上层包固定安装：`pdf-lib@1.17.1`（MIT，[源码](https://github.com/Hopding/pdf-lib/tree/v1.17.1)）、`fflate@0.8.3`（MIT，[源码](https://github.com/101arrowz/fflate/tree/v0.8.3)）、`fast-xml-parser@5.11.2`（MIT，[源码](https://github.com/NaturalIntelligence/fast-xml-parser/tree/v5.11.2)）。pdf-lib 内部 PDF.js 派生解码代码另保留 Apache-2.0 版权头，顶层 MIT 不替代该声明。运行时传递依赖与实际安装包许可文本的抽取/分发审查仍待主代理完成；此处不声称审查完毕。分发时保留这三个包及传递依赖的许可文本；本模块是 YY 的 Apache-2.0 代码，不重新授权第三方。实现不依赖 Node built-ins 或动态 WASM。

定位与证据：

- PDF 使用零起始原 `pageIndex`、points 尺寸及旋转角；copyPages 生成单页 PDF 保留页面内容，不先 OCR 或虚构 bbox。加密 PDF 按 pdf-lib 原行为拒绝。
- DOCX 使用原 XML part、`blockIndex`、`sectionIndex`；段落保留文字/制表/换行顺序，表格保留行列、gridSpan、verticalMerge 与各单元格段落。图片保留 drawing anchor/inline 的位置和 extent。不是 Word 打印页。
- XLSX 使用 sheet/name/part 与 `range`。默认 32 行 × 16 列；超出 64 KiB 递归拆分，保留原 ref、样式编号、公式及其缓存值、相交 merges、行列属性和图片锚点。公式和缓存分别记录，不把缓存称为重新计算结果；保留 workbook date1904 的 1900/1904 日期系统，不擅自把数字解释成日期。跨范围 two-cell 图片在所有相交单位保留；one-cell extent/absolute anchor 的单元格覆盖无法确定，明确报告并附到该 sheet 每个单位，不猜测图片终点。只有图片的工作表也可形成单位。
- PPTX 使用原 slideIndex/part；保留 shape/group 顺序、shapePath、局部几何、段落与图片关系。未合成 PNG 或假页；主题/母版继承与复杂绘制未执行。group 几何保持局部变换，不伪装成已求解的绝对位置。

XML 先严格校验，再按 namespace URI（含 transitional/strict OOXML URI）解析；不依赖 `w/r/p` 等前缀拼写。禁止 DTD/entity 声明、未绑定前缀及同 URI 的重复属性。ZIP 路径拒绝绝对路径、NUL、反斜线、越界父路径、重复规范化部件；关系目标按所在部件解析，外部关系仅报告、不 fetch。图片 MIME 仅为包内 Content Types 声明，真正解码/格式接纳由消费者的 nativeMedia 校验，不能凭声明伪造支持。

资源边界是单次接纳/执行限制，不是资料库总存储上限：原件 8 MiB；ZIP 512 部件、单部件 8 MiB、总展开 24 MiB；XML 单部件 1 MiB、深度 64、节点 65,536；原生单位最多 128，纠正时可另加一个 Owner 注释单位；单 context 及单图片元数据集合各最多 64 KiB；PDF 每个解码 stream 8 MiB、累计解码缓冲分配 24 MiB；每个输出页 8 MiB、派生 PDF 合计 16 MiB。构建必须通过 `preparePdf()` 的有界 pdf-lib 别名，拒绝原库旁路。超限明确报错，不截断内容充当完整理解。ZIP 以 4 KiB 压缩块增量展开并在保留输出前核对限额；这是实现约束，不代表已测出所有恶意样本下的内存峰值。

每单位及文档总 coverage 均保留未执行/未支持项：DOCX header/footer/footnote 等关系、编号/样式继承、嵌套表格、修订/旧 VML；XLSX 图表/主题/重算；PPTX 母版/版式/主题及 graphicFrame 等复杂对象。原件始终可回查。未支持对象不应被解释为整文件没有相应内容，也不能因基础文字与图片已解析而宣布整文件语义覆盖。旧 `.doc/.xls/.ppt`、宏执行和解密不在 MIME 列表中。

验证入口 `node --test memory/test/documents.test.mjs`（实际 cwd 为仓库根时）。测试在授权家庭环境执行：浏览器 bundle 进入真实 workerd，无 nodejs_compat；固定生成 PDF/OOXML 及原生 PNG 验证前缀别名、段表结构、跨区域图锚、公式缓存与拒绝边界。测试不等同 Office 应用导出全兼容、真实模型语义、生产生命周期或已部署。


## 业务接线与读取

`/ingest` 创建 whole-source queued job，`/document/status` 查询，`/document/step` 显式推进，`/document/recover` 仅在明确接受未知效果后用新 operationId/revision 恢复，`/document/units` 导航已完成根的单位。全部单位完成才发布根。原件根 read 返回上传 bytes；子单位 read 是包含 native page/image 数据的派生 JSON，附原件引用、locator 和 coverage。correct/reinspect 只在根上重建全部单位，旧根与子证据失效；子单位直接修改/恢复返回 `document_root_required`，delete/revoke 也须操作根。共同原件根不构成独立佐证，search 分组也不是跨页结论；没有文档跨页推理 endpoint，跨源命题关系继续遵守现有 knowledge 规则。

图片裁剪保留 viewport 参数，但供模为完整 embedded asset，标记 `full-embedded-asset` 与 `image-crop-not-rendered`，未应用裁剪或排版；不能把原资产中的隐藏细节当成文档实际可见内容。外链、headers/themes/chart 等未解析部分均保留 coverage。

文档 native query 原件最多 2 MiB；PDF 最多六页，Office 表示最多六个媒体 parts 与 64 KiB 结构文本。文档 embedding 请求使用 `autoTruncate: false` 要求拒绝超长输入；该配置的真实 Provider 验证尚待完成，不以静态参数存在声称通过。

Owner 局部纠正不替代全部原生观察：整源重建重新观察 native units，并追加一个 `owner-correction` locator 单位，scope 绑定当前 root ref，保留原语句的位置限定。原页命题保持 observation 权威，Owner 单位命题为 owner；该单位不能产出 native documentEvidence，只可成为相关的 owner-correction 检索上下文。

确定空结构（空段、无 Contents / Annots 的 PDF 页、空 shape/worksheet）仍保留可读单位与原生 locator；跳过 perception/embedding/Hy/knowledge，不建 vector/claim，根任务可完成。模型失败、未读清的非空内容不得走此空单位路径。
