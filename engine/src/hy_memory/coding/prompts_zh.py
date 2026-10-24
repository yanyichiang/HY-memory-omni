# -*- coding: utf-8 -*-
"""HY Memory working/coding 链路使用的中文提示词模板。"""


EXTRACT_PROMPT_ZH = """\
你需要从一段任务执行会话中抽取可长期保留的 WORKING 记忆。
“working”会话是指用户通过工具操作计算机或系统的任何实操任务——既包括软件/代码
工作（编写、调试、重构、构建、部署、API/library 使用），也包括系统与运维工作
（运行 shell/PowerShell 命令、磁盘/存储分析或清理、文件与文件夹操作、安装/配置
软件、环境/设备设置、硬件/磁盘健康检查、备份、调度/自动化、数据处理）。

你需要从同一段会话中产出两个层次：

  EXPERIENCES（过程性，“如何做”）——可复用的方法；只有达到下述 VALUE BAR 时才
  抽取。每条是一个 (task, search_keys, solution, boundary_envs) 组合。

  FACT（情节性，“这次发生了什么”）——关于本次会话的恰好一条记录：用户想做什么、
  大致如何推进、最终结果如何。它不受价值门槛限制，但绝不能超过一条。

这两个层次回答不同问题，并分别存储。可泛化的方法放入 EXPERIENCES；只对这个系统、
这个项目、此时此刻成立的本次会话经历放入 FACT。

═══════════════════════════════════════════════════════════════════
VALUE BAR（仅适用于 EXPERIENCES）——不要轻易越过此门槛。
═══════════════════════════════════════════════════════════════════
一条记忆必须同时满足以下全部条件：
  (a) 解决了同一用户以后很可能再次遇到的问题
  (b) 解决方案并非琐碎操作：它组合了多项信息/多个步骤，或者包含决策理由，或者记录了
      来之不易的 workaround，或者是某项运维任务的可复用流程/配方（例如如何分析并
      清理磁盘占用、如何批量整理文件、如何检查硬件健康、如何设置 scheduled job）
  (c) 未来的 agent / 用户会更愿意查阅它，而不是重新摸索

重要——分析、诊断、调查任务也算：
一项任务不必实际修改或“修复”任何东西才值得记忆。只读、分析、故障排查工作，只要其
流程或结论可复用，就有价值。明确抽取：
  - 分析/诊断配方：可复用的流程以及它揭示的结果（例如“如何分析哪些文件夹占用了
    C-drive 空间”——扫描命令、遇到的坑和最终发现）。“只生成了报告，没有修改”
    不是跳过理由——可复用的方法本身就是记忆。
  - 调查结果，包括否定结果或未找到结果（例如“使用 rg / fs_search / SQL index
    在 C: 和 D: 中搜索 folder X——任何位置都未找到”）。记录一条死路可以避免下一个
    agent 重复同样无果的搜索，因此达到了价值门槛。
不要仅仅因为“assistant 可以重新生成这些命令”或“实际上没有修改任何东西”就拒绝
一条记忆。只要流程或结论能节省未来的工作，就保留它。

不要抽取：
  - 没有可复用流程、真正琐碎的单步操作（“rename one file”、“git status”、
    “run ls once”）
  - 已经解决且没有可迁移经验的一次性问题
  - repo/system 中已经存在的信息（不要重复 package.json）
  - 每个 PR / 每次会话的一次性任务，除非其中编码了可复用模式
  - 向用户询问缺失信息这一行为。请求参数、列出未知项或引导用户提供必填字段属于
    对话行为，不是方法：每个 agent 都知道如何提问，因此以后没有任何值得查阅的内容。
    绝不要产出 task 或 search_keys 形如“how to ask for X”、“gather the missing Y”、
    “eliciting required fields”、“what to clarify before starting”的 experience。
    注意，这条限制只适用于 EXPERIENCES——会话最终停在等待用户的状态是真实状态，
    应写入 FACT。

如果该段会话因为等待用户而没有取得任何实质进展——assistant 只是询问参数，或者在
开展任何实际工作前就被阻塞——输出 "experiences": []，只写 FACT。此时尚未学到任何
东西，因此没有方法可存。这一点比看起来更重要：从停滞中提炼出的 experience 在检索时
会像一项真正的技能；同一任务的后续片段会匹配它，再次向用户提问而不是继续推进，导致
这种停滞在余下会话中不断自我复制。应根据工具实际做了什么判断是否有实质进展，而不是
根据该轮是否生成了流畅文本。

启发式标准：如果用户（或未来执行同类任务的 agent）希望把它记下来，而不是以后再重新
摸索，就保留。多步骤运维流程通常符合条件——包括 system/ops 或只读分析/搜索流程，
不局限于代码。只有当它只是任何用户都能在 30 秒内通过 `--help` 找到的单条命令，并且
不包含值得记忆的决策或坑点时，才丢弃。

═══════════════════════════════════════════════════════════════════
EXPERIENCE 字段
═══════════════════════════════════════════════════════════════════

task          — 采用查询式名称；写成用户以后会如何提问。
                使用“publish a release to the xx platform”，不要使用
                “publish_release_internal”。
                必须自包含（不要使用“this”、“the file”、“we”）。

search_keys   — 0 到 5 种替代表述，用来覆盖仅靠 `task` 无法匹配、但对 solution 很
                重要的方面。写成未来用户会询问的问题或主题，且必须与 task 有区别。
                如果 task 已覆盖全部内容，则省略。

solution      — 用户实际需要的完整、自包含内容：命令、凭据位置（不是凭据值）、
                文件路径、有序步骤、坑点、决策理由。如果多轮端到端工作构成一个连贯
                任务，应聚合成一个 solution；只有用户执行了互不相关的任务时才拆成
                多条记忆。

boundary_envs — solution 所依赖的具体限定条件，使用多行“key: value”：
                  runtime / SDK / library + version
                  API endpoint 或 method signature
                  external service / middleware version
                  env var NAME（不是值）
                  config file path
                  host / cluster / region identifier
                如果 solution 与环境无关，填写 ""（空字符串）。
                目的：底层 SDK/middleware 升级后，未来使用者可以据此判断 solution
                是否仍然适用。

confidence  — 0.0 到 1.0
  1.0   用户明确将其陈述为规则/指令
  0.7   根据工具操作及充分证据推断
  0.5   弱推断；只有一次观察；不确定

═══════════════════════════════════════════════════════════════════
FACT 字段——每段会话恰好一条，无价值门槛
═══════════════════════════════════════════════════════════════════

你要为整段会话写一条 FACT——它是本次会话可恢复的状态记录，不是精心润色的回顾，也
绝不是分散发现的列表。未来 agent 必须能够从中继续推进，且不会把建议、推断或局部搜索
误认为已经验证的事实。

subject    — 本次会话围绕谁或什么展开：工作所针对或服务的单一实体。使用简短名词
             短语，不要写句子，不要使用动词。选择会话真正围绕的最具体实体，而不是
             所使用的工具：
               会话服务于某个具名人员时，使用人名
                 （“Dylan”、“Matthew”）
               工作针对代码时，使用 file / module / symbol
                 （“auth/middleware.ts”、“parse_plan_text”）
               运维工作使用 service / host / device / drive
                 （“D:\\WXWork”、“redis-cache-prod”、“ci.yml”）
             这是 HARD KEY，不是散文：关于不同人员或不同文件的两次会话必须得到不同
             subject；关于同一实体的两次会话必须得到拼写完全一致的同一字符串。
             优先使用 trace 中出现的精确标识符，而不是对它的描述。如果该段确实没有
             单一 subject，输出 ""。

             这很重要：subject 是决定后续会话是否可以按“同一任务的继续”覆盖本条
             记录的闸门。填错后，一个人的状态可能静默替换另一个人的状态。

statement  — 本次会话的紧凑记录。它分为两部分，而第二部分最容易丢失。
             保留任务范围内的给定量和具体约束，不要用泛泛的结果评价取代它们。
             每条规则只写一次：重复的指令文字会挤占记忆真正需要保留的数据。

             PART 1——发生了什么，约 300 个拉丁字符（约 150 个 CJK 字符）。
             从具体目标和对象开始（“reclaim disk space taken by D:\\WXWork”、
             “locate the new_file_search folder”），不要写泛泛的“fix a bug”/
             “find a file”。然后概述检查、尝试或修改了什么。最后说明结束状态，
             且语义必须精确对应以下之一：completed、partially completed、failed、
             blocked、still awaiting verification。纳入否定结果和死路，但不要夸大。

             PART 2——TASK-SCOPED GIVENS：整个任务赖以运行的全部给定信息，即使并非
             本段会话建立，或看起来基础到不值得写。包括绑定关系（每个 name/symbol/
             label 代表什么）、任务提供而不是推导出的固定值、采用的约定（indexing
             base、units、timezone、defaults），以及本段自己的结果和值（写“x = 7”，
             不要只写“the value was computed”）。

             将 PART 2 写成数据，每行一项，值保持给定形式：
               retry budget = 5; timeout 30s; index starts at 0
               step 3 input: n=64, tolerance 1e-6
               slot B: type=private, cost 688.7-721.3 per unit
             每一行几乎都应由值构成。保留 trace 的 notation——symbols、units、
             numbers、spellings——删掉其句子外壳：去掉那些只是宣告“这是给定量”的
             短语，而非给定量本身（“I would prefer”、“it should be somewhere
             between … and …”）。这些短语会在每项重复；一个 15 项列表会为它们
             支付 15 次空间成本。
             每一条 FACT 都要携带这些信息；绝不要写“as above”或“same as the
             previous session”——检索只会按相似度返回少量 facts，被指代项可能不在
             其中。

             总长度尽量控制在 1200 字符以内。如果 PART 2 放不下，应优化 notation，
             绝不能削减覆盖范围：statement 是 retrieval vector，也是后续 segment
             唯一能读到的字段（details 既不做 embedding，也不会被注入），因此从中
             删除的内容就永久丢失。压缩给定量周围的措辞，绝不要压缩给定量本身。

             检验标准：如果下一段看不到原始材料，能否仅凭此记录继续任务？只有肯定
             答案才合格。缺失 binding 不会明显报错——该名称仍看起来有意义，于是会
             按其通用含义被理解，后续答案可以很流畅，却回答了另一个问题。

             LANGUAGE——使用与 session trace 相同的语言：statement 是 retrieval
             vector，而查询会使用用户的工作语言；改用另一种语言会让每次检索都付出
             跨语言匹配损失。

             EVIDENCE FIDELITY——只记录 trace 中实际执行的操作和明确存在的证据。
             对关键命令、flags、arguments、errors、numbers 保持原样。
             绝不要按惯例补全命令 flags，也不要把建议或计划写成已经执行的动作：
               “ran Get-ChildItem -Force” → “ran Get-ChildItem”
                 （trace 中没有 `-Force`，不要杜撰）
             每个否定发现都必须限定在实际搜索范围内，并逐一列出可能使其失效的所有
             明确覆盖限制，尤其是 permission failures 和 depth limits：保留当时的
             roots、filters、depth（“not found under C:\\ and D:\\ at depth 3;
             some directories were not covered due to Access denied”），绝不要扩大为
             “does not exist”。不要为了让记录更漂亮而漏掉任何限制。
             绝不要把局部搜索提升为全局不存在。
             被阻塞的尝试必须保留其 blocker。
             保留 attempted、observed、verified、inferred、unresolved 之间的区别；
             用自然语言表达（“tried … but was blocked by Access denied”、
             “suspected …, not yet verified”），不要把它们当标签。没有工具输出或
             明确确认时，绝不要声称修复已成功、原因已确定或路径不存在。

             不要记录问候或纯闲聊——只有这种情况才输出 "fact": null。仅仅陈述了
             要求，或尚未开展工作就停滞的会话，仍然建立了信息。

details    — 本次会话的具体 OUTPUT，逐字复制。`statement` 是摘要，而摘要必然会
             丢掉各个具体值；后续检索几乎总是在寻找某个具体值，而非大意。因此，只要
             会话产出了可寻址的结果，就以原始形式和结构复现在这里：
               plan / schedule / itinerary → 每一行、每一天、每个 slot、每个 price
                 都严格按原文保留
               config 或 code block → 保留整个 block
               command 的关键 output → 保留承载发现的行（sizes、counts、versions、
                 error text）
               structured result（table、records list）→ 保留各行
             保留原始布局——line breaks、`Day 1:` / key: value prefixes、units、
             currency symbols、ids。不要再次概括，不要重排，不要舍入数字，不要翻译。

             只复制 trace 中实际存在的内容。绝不要填补空缺：如果某个 slot 没有填，
             就保持未填或明确说明——杜撰的值比缺失的值更糟，因为它会被检索并使用。
             长度控制在约 4000 字符；如果输出更长，保留承载具体值的部分，删去装饰性
             文字，并注明删掉了什么。

             如果本次会话未产生此类 artifact（尚无发现的纯调查，或等待用户导致的
             停滞），填写 ""。

             此字段不属于 retrieval vector——`statement` 和 `subject` 负责找到
             记录，`details` 在找到后提供具体值。因此不要在此堆砌检索诱饵，也不要
             重复摘要；只写原始内容。

files      — 0..N 个本次会话中实际操作或调查过的绝对或 repo-relative FILE OR
             DIRECTORY paths。保留调查过的 roots，例如 `C:\\` 和 `D:\\`。只包含
             实际访问/搜索过的路径，不包含仅建议或计划访问的路径；不适用时填写 []。
═══════════════════════════════════════════════════════════════════
HOST CONTEXT（由 SDK 提供）
═══════════════════════════════════════════════════════════════════
- workspace_id present: {workspace_present}
- branch present: {branch_present}

没有 workspace_id 时，solution 不能依赖未声明的项目本地上下文——必须在 `solution`
或 `boundary_envs` 中明确写出其所需的 repo / path / service，使记忆能够独立使用。

═══════════════════════════════════════════════════════════════════
CONVERSATION
═══════════════════════════════════════════════════════════════════
{conversation_block}

═══════════════════════════════════════════════════════════════════
OUTPUT（仅输出严格 JSON，不要 markdown）
═══════════════════════════════════════════════════════════════════
{{
  "experiences": [
    {{
      "task": "...",
      "search_keys": ["...", "..."],
      "solution": "...",
      "boundary_envs": "...",
      "confidence": 0.9
    }}
  ],
  "fact": {{
    "subject": "...",
    "statement": "...",
    "files": ["..."],
    "details": "..."
  }}
}}

默认应进行抽取。当该段会话确实完成了实际工作时，必须输出至少一条 experience——即使
任务看似简单或一次成功，也要记录所做工作的可复用本质（method / command / how-to）。
会话内容较少时，只保留最有价值的一条 experience 即可。

唯一例外是上述停滞情况：如果该段因为缺少信息、被阻塞在向用户提问而没有开展实际工作，
输出 "experiences": []，只写 fact。不要为了满足本指令而杜撰 experience——杜撰的
“how to ask for the departure city”比没有记忆更糟，因为以后会被检索并照做。只有这个
原因允许空数组；实际开展过工作时，绝不能把空数组当捷径。

"fact" 是单个对象，绝不是列表——每次会话一条记录。

始终写 fact。fact 的门槛不是“这是否有价值”，而是“是否发生了任何事情”；能够到达
你的 segment 已经越过这条门槛。这包括看起来只是 setup 而非工作的片段：仅有一条用户
消息陈述 requirements、parameters 或 starting state，即使没有运行工具，也恰恰是后续
会话无法自行重建的材料——把需求、参数、起始状态连同情形一起写进 `statement`（紧凑
记法，不要照抄对话原句），不要推给 `details`（`details` 不进检索向量，读取侧也不再
注入它）。只有完全没有内容的问候和纯闲聊才使用 "fact": null。有疑问时应写 fact：
多余记录只多占一行，而漏掉记录会伤害每一次需要它、却无从知道它曾存在的后续会话。
"""


EXTRACT_PROMPT_CODING_ZH = """\
╔═══════════════════════════════════════════════════════════════════════════╗
║ HARD CONSTRAINT——先阅读本节；它覆盖本提示词后文任何看似要求叙事的措辞。      ║
║                                                                           ║
║ 你不是在撰写某个人做过什么的报告。你要写的是 FUTURE AGENT 为采取行动所需要 ║
║ 的信息。该 agent 已有自己的任务；它不关心这个用户想要什么。它需要知道：此处 ║
║ 做出了什么决定、位于哪些代码坐标、尝试并否决了什么，以及是否经过验证。       ║
║                                                                           ║
║ 具体来说，每个 `statement` 和每个 `solution` 都必须遵守：                 ║
║   · 语法主语必须是 CODE 或 THE DECISION——绝不能是“the user”，也绝不能是   ║
║     “the agent”。不要写“The user attempted to…”、“The user wanted…”、   ║
║     “The agent then checked…”。                                           ║
║   · 绝不要用“the session was completed”、“the error was noted”、         ║
║     “no solution was found yet”之类流水账短语收尾。结尾应写决定及其验证    ║
║     状态。如果没有做出决定，就以已排除的内容和下一条尚未探索的线索收尾——这才 ║
║     是可复用部分。                                                        ║
║   · 保留具体症状（error string、failing command、wrong output）——未来搜索 ║
║     正是通过这些内容命中。                                                ║
║                                                                           ║
║ bad:  “The user attempted to write a QTable to RST with header_rows and   ║
║        hit a TypeError. The session was completed with the error noted.”  ║
║ good: “ascii.rst's RST writer rejects header_rows:                        ║
║        `tbl.write(..., format='ascii.rst', header_rows=['name','unit'])`  ║
║        raises TypeError because RST.__init__ does not forward it, unlike  ║
║        ascii.fixed_width which accepts it. No fix written — the writer    ║
║        needs the same header_rows plumbing as fixed_width.”               ║
╚═══════════════════════════════════════════════════════════════════════════╝

你需要从一段任务执行会话中抽取可长期保留的 WORKING 记忆。
“working”会话是指用户通过工具操作计算机或系统的任何实操任务——既包括软件/代码
工作（编写、调试、重构、构建、部署、API/library 使用），也包括系统与运维工作
（运行 shell/PowerShell 命令、磁盘/存储分析或清理、文件与文件夹操作、安装/配置
软件、环境/设备设置、硬件/磁盘健康检查、备份、调度/自动化、数据处理）。

你需要从同一段会话中产出两个层次：

  EXPERIENCES（过程性，“如何做”）——可复用的方法；只有达到下述 VALUE BAR 时才
  抽取。每条是一个 (task, search_keys, solution, boundary_envs) 组合。

  FACT（情节性，“这次确立了什么”）——关于本次会话的恰好一条记录。它不是用户做了
  什么的叙事，而要按以下顺序记录：任务及其具体症状（使它以后能被检索到）、代码坐标、
  最终采用了什么以及拒绝了什么、验证推进到什么程度。它不受价值门槛限制，但绝不能
  超过一条。

这两个层次回答不同问题，并分别存储。可泛化的方法放入 EXPERIENCES；只对这个系统、
这个项目、此时此刻成立的本次会话经历放入 FACT。

═══════════════════════════════════════════════════════════════════
VALUE BAR（仅适用于 EXPERIENCES）——不要轻易越过此门槛。
═══════════════════════════════════════════════════════════════════
一条记忆必须同时满足以下全部条件：
  (a) 解决了同一用户以后很可能再次遇到的问题
  (b) 解决方案并非琐碎操作：它组合了多项信息/多个步骤，或者包含决策理由，或者记录了
      来之不易的 workaround，或者是某项运维任务的可复用流程/配方（例如如何分析并
      清理磁盘占用、如何批量整理文件、如何检查硬件健康、如何设置 scheduled job）
  (c) 未来的 agent / 用户会更愿意查阅它，而不是重新摸索

重要——分析、诊断、调查任务也算：
一项任务不必实际修改或“修复”任何东西才值得记忆。只读、分析、故障排查工作，只要其
流程或结论可复用，就有价值。明确抽取：
  - 分析/诊断配方：可复用的流程以及它揭示的结果（例如“如何分析哪些文件夹占用了
    C-drive 空间”——扫描命令、遇到的坑和最终发现）。“只生成了报告，没有修改”
    不是跳过理由——可复用的方法本身就是记忆。
  - 调查结果，包括否定结果或未找到结果（例如“使用 rg / fs_search / SQL index
    在 C: 和 D: 中搜索 folder X——任何位置都未找到”）。记录一条死路可以避免下一个
    agent 重复同样无果的搜索，因此达到了价值门槛。
不要仅仅因为“assistant 可以重新生成这些命令”或“实际上没有修改任何东西”就拒绝
一条记忆。只要流程或结论能节省未来的工作，就保留它。

不要抽取：
  - 没有可复用流程、真正琐碎的单步操作（“rename one file”、“git status”、
    “run ls once”）
  - 已经解决且没有可迁移经验的一次性问题
  - repo/system 中已经存在的信息（不要重复 package.json）
  - 每个 PR / 每次会话的一次性任务，除非其中编码了可复用模式

启发式标准：如果用户（或未来执行同类任务的 agent）希望把它记下来，而不是以后再重新
摸索，就保留。多步骤运维流程通常符合条件——包括 system/ops 或只读分析/搜索流程，
不局限于代码。只有当它只是任何用户都能在 30 秒内通过 `--help` 找到的单条命令，并且
不包含值得记忆的决策或坑点时，才丢弃。

═══════════════════════════════════════════════════════════════════
CODE WORK——未来 agent 无法重新推导的信息，因此必须捕获
═══════════════════════════════════════════════════════════════════
当该段是针对 repository 的软件工作时，可复用方法只占一半。另一半是工作位于哪里，
以及哪个版本胜出。这些无法通过以后阅读代码恢复——代码只能展示当前状态，无法说明它
位于哪个 branch，也无法说明哪些方案已被否决。

本节不是要求写得更长，而是要求把相同预算花在价值更高的 token 上：删掉重复目标、
assistant“随后决定”做什么的叙事，以及只是复述的粘贴代码；把这些字符用于下面四项。
一条遗漏 branch、却引用 30 行 diff 的记录是糟糕的取舍。

1. BRANCH / WORKING LOCATION——逐字写入 fact `statement`。如果该段提到或 checkout
   了 `feat/x` / `fix/y`，这个 token 必须出现。在错误 branch 上恢复工作的 agent
   会产生随后被静默丢弃的改动，因此这一个 token 的优先级高于其他任何细节。

2. WHICH VERSION WON——当用户改变主意时，用一个分句指出胜出者并标记落败者：
   “settled on A; the interim B was dropped”。不要完整保留两个版本，只需一个分句。
   只保留最新版本是错误的：以后遇到被否决代码的 agent 必须识别它，否则会把代码
   “修复”回已经丢弃的变体。`scratch that / go back to / actually, let's / no, not that`
   之类措辞就是标志：后面的内容才是正式结论，前面的内容已被 superseded。

3. EXACT COORDINATES, NOT PASTED CODE——使用 repo-relative path
   （`qutebrowser/utils/debug.py`，绝不要只写 `debug.py`）以及触及的 function /
   class。如果 signature 发生变化，给出新的 signature。如果决定的是 constant、regex
   或 literal，逐字引用它——但只引用这一项，不要引用周围 block。准确的一行胜过一段
   近似描述。

4. VERIFIED vs MERELY WRITTEN——四个词就足够（“tests run and passing”/
   “confirmed by git diff only, tests not run”）。“the edit is in”和“the edit is in
   and tested”会让未来 agent 采取完全不同的下一步。

反例——只总结目标，却丢掉坐标：
  bad:  “refactored the colour parsing logic to be cleaner.”
  good: “on feat/q4, in qutebrowser/config/configtypes.py QtColor._parse_value:
         settled on `mult = 360.0 if kind == 'h' else 255.0`; the interim version that
         used 255.0 for everything was dropped. Tests not run.”
  （good 往往比 bad 还短——它只是把每个字符都用在无法重新推导的信息上）

═══════════════════════════════════════════════════════════════════
EXPERIENCE 字段
═══════════════════════════════════════════════════════════════════

task          — 采用查询式名称；写成用户以后会如何提问。
                使用“publish a release to the xx platform”，不要使用
                “publish_release_internal”。
                必须自包含（不要使用“this”、“the file”、“we”）。

search_keys   — 0 到 5 种替代表述，用来覆盖仅靠 `task` 无法匹配、但对 solution 很
                重要的方面。写成未来用户会询问的问题或主题，且必须与 task 有区别。
                如果 task 已覆盖全部内容，则省略。

solution      — 用户实际需要的完整、自包含内容：命令、凭据位置（不是凭据值）、
                文件路径、有序步骤、坑点、决策理由。如果多轮端到端工作构成一个连贯
                任务，应聚合成一个 solution；只有用户执行了互不相关的任务时才拆成
                多条记忆。

boundary_envs — solution 所依赖的具体限定条件，使用多行“key: value”：
                  runtime / SDK / library + version
                  API endpoint 或 method signature
                  external service / middleware version
                  env var NAME（不是值）
                  config file path
                  host / cluster / region identifier
                如果 solution 与环境无关，填写 ""（空字符串）。
                目的：底层 SDK/middleware 升级后，未来使用者可以据此判断 solution
                是否仍然适用。

confidence  — 0.0 到 1.0
  1.0   用户明确将其陈述为规则/指令
  0.7   根据工具操作及充分证据推断
  0.5   弱推断；只有一次观察；不确定

═══════════════════════════════════════════════════════════════════
FACT 字段——每段会话恰好一条，无价值门槛
═══════════════════════════════════════════════════════════════════

你要为整段会话写一条 FACT——它是本次会话可恢复的状态记录，不是精心润色的回顾，也
绝不是分散发现的列表。未来 agent 必须能够从中继续推进，且不会把建议、推断或局部搜索
误认为已经验证的事实。

statement  — 本次会话的紧凑摘要。它同时承担两个职责，且两者都必须完成：它既是
             retrieval vector（未来 agent 用一份新 issue report 搜索它；措辞方式
             与用户报告问题的方式一致），也是该 agent 找到后要据以行动的 payload。
             因此：

             开头写任务和症状，使用用户会使用的措辞。
                这是保证可检索性的关键——表述应尽量贴近问题被报告时的表面形式。
                点明具体目标和对象（“reclaim disk space under D:\\WXWork”、
                “adjust the hue multiplier in QtColor._parse_value on feat/q4”、
                “locate the new_file_search folder”），绝不要写泛泛的“fix a bug”/
                “look for a file”。包含具体症状：error string、failing command、
                wrong output。

             然后给出坐标和决定。
                对代码工作写 repo-relative path、symbol 和 branch。说明最终 SETTLED ON
                什么，并在同一分句标记丢弃了什么（“settled on X; the interim Y was
                dropped”）。这部分无法通过阅读代码重新推导——代码只展示胜出者，从不
                展示 Y 曾被尝试后否决。以后遇到被否决变体的 agent 必须能识别它，
                否则会把代码“修复”回已丢弃版本。

             结尾写证据状态。
                必须精确对应以下之一：completed、partially completed、failed、blocked、
                still awaiting verification；还要写明如何检查（“tests run and passing”/
                “confirmed by git diff only, tests not run”）。纳入否定结果和死路，
                但不要夸大。

             ⚠️ 绝不要停留在叙事层。“The user tried X and hit error Y; no solution found
             yet”是一条浪费的记录：它容易被检索到，却不能指导未来 agent 行动。如果
             本次确实没有得出决定，就说明排除了什么、下一条尚未探索的线索是什么——
             这才是可复用部分。

             句子的主语应是 code 和 decision，而不是“the user”。使用 2 到 4 个连贯
             句子，不要写带标签的小节。硬上限约 400 个拉丁字符（约 200 个 CJK 字符）。

             EVIDENCE FIDELITY——强制要求：
             - 只记录 trace 中实际执行的操作和明确存在的证据。对关键 commands、flags、
               arguments、errors、numbers 保持原样。绝不要按惯例补全 command flags，
               也不要把 advice/plans 写成已执行的动作。
             - 保留 attempted、observed、verified、inferred、unresolved 之间的区别。
               不要把这些词作为标签写进正文；自然表达其含义，例如“tried … but was
               blocked by Access denied”或“suspect …, not yet verified”。
             - 没有工具输出或明确确认时，绝不要声称修复成功、原因已经确定、file/folder
               不存在或 tests passed。
             - 每个否定发现都必须限定在实际搜索范围内，并逐一列出可能使其失效的所有
               明确覆盖限制，尤其是 permission failures 和 maximum search depth：
               “not found within the searched parts of C:\\ and D:\\; some directories
               were skipped on Access denied, and the search was also depth-limited”。
               不要为了摘要更漂亮而漏掉任何限制。绝不要把局部搜索提升为全局不存在。
             - 只有 trace 直接验证了因果关系时，才能确定地陈述因果。否则保留限定词
               （“suspected”/“inferred”/“not yet verified”）；不要把错误的测试假设
               改写成系统的 root cause。

             关键——这段文字就是 retrieval vector，也是未来 query 唯一会匹配的内容。
             泛泛摘要毫无价值，因为每次会话看起来都像泛泛摘要：它会匹配所有查询，
             却无法回答任何一个。因此必须写出使本次会话可检索的具体 anchors——真实
             file paths、function / symbol names、branch names、commands、error strings、
             versions、config keys and values、host / service names。以后有人搜索其中任一
             具体项时，本摘要必须能被返回。
               good: “fixing a failing `npm run build` in CI. Read
                      .github/workflows/ci.yml and package.json; traced it to webpack
                      5.74 hitting ERR_OSSL_EVP_UNSUPPORTED under node 18. Bumping the
                      workflow's node to 20 made the build pass; node 18 still
                      reproduces locally.”
               good: “on branch feat/q0, in qutebrowser/utils/debug.py signal_name:
                      PyQt<5.11 only exposes the name via repr(sig), and repr comes in
                      both a bracketed and a parenthesised form. Settled on two patterns
                      tried in order with fullmatch, breaking on the first hit; the
                      single-regex version was dropped. Confirmed by git diff, tests not
                      run.”
               bad:  “user wanted a build bug fixed, the agent looked at some config
                      files, changed some code, and fixed it.”
                      （没有 path、command、error string、version——没有任何可检索锚点；
                       每次会话都可以写成这样）
               bad:  “fixed the signal-name parsing compatibility issue on a feature
                      branch.”
                      （哪个 branch？哪个 file？哪个 function？两个竞争版本中谁胜出？
                       一周后检索到它时，没有任何信息仍然有用）
             忠实度示例（bad → good）：
               “ran Get-ChildItem -Force” → “ran Get-ChildItem”
                 （trace 中没有 `-Force`，不要杜撰）
               “confirmed new_file_search does not exist” →
                 “new_file_search was not found within the searched parts of C:\\ and
                  D:\\; some directories were skipped on Access denied or by the depth
                  limit, so the investigation is only partly done”
               “identical payloads cause a spurious lock error” →
                 “the verification script assumed the last writer is always a fixed
                  rank; that assumption does not hold, so whether there is a lock bug
                  is still unverified”

             不要记录问候或纯闲聊。如果该段完全没有建立任何信息，输出 "fact": null。

files      — 0..N 个本次会话中实际操作或调查过的绝对或 repo-relative FILE OR
             DIRECTORY paths。保留调查过的 roots，例如 `C:\\` 和 `D:\\`。只包含
             实际访问/搜索过的路径，不包含仅建议或计划访问的路径；不适用时填写 []。

═══════════════════════════════════════════════════════════════════
HOST CONTEXT（由 SDK 提供）
═══════════════════════════════════════════════════════════════════
- workspace_id present: {workspace_present}
- branch present: {branch_present}

没有 workspace_id 时，solution 不能依赖未声明的项目本地上下文——必须在 `solution`
或 `boundary_envs` 中明确写出其所需的 repo / path / service，使记忆能够独立使用。

═══════════════════════════════════════════════════════════════════
CONVERSATION
═══════════════════════════════════════════════════════════════════
{conversation_block}

═══════════════════════════════════════════════════════════════════
OUTPUT（仅输出严格 JSON，不要 markdown）
═══════════════════════════════════════════════════════════════════
{{
  "experiences": [
    {{
      "task": "...",
      "search_keys": ["...", "..."],
      "solution": "...",
      "boundary_envs": "...",
      "confidence": 0.9
    }}
  ],
  "fact": {{
    "statement": "...",
    "files": ["..."]
  }}
}}

强制要求：必须输出至少一条 experience，不要返回空列表。即使任务看似简单或一次成功，
也要记录所做工作的可复用本质（method / command / how-to）。会话内容较少时，只需要
最有价值的一条 experience——但绝不能输出空的 "experiences" array。

"fact" 是单个对象，绝不是列表——每次会话一条记录。只有该段是没有建立任何信息的
纯闲聊时，才使用 "fact": null。
"""


RECONCILE_PROMPT_ZH = """\
你需要决定如何将新的 coding memory drafts 与用户已有的 memories 合并。

对每条新 draft，选择以下一种 action：
  ADD     — 没有已有 memory 描述相同的任务/方面
  UPDATE  — 某条已有 memory 描述相同任务；用新 draft 替换它
            （solution 可能已经变化，env 可能已经升级，等等）
  SKIP    — 与已有内容重复；没有新信息

此外，当新内容使已有候选失效或作废时，可以针对已有 candidates 输出 DELETE ops：
  DELETE  — 新 conversation 明确 supersedes/cancels/invalidates 某条已有 memory，
            且无法通过 UPDATE 修复。示例：
              * 用户说“don't use X anymore”，而 X 只存在于另一条独立 memory 中
                （不是本次正在 ADD/UPDATE 的那条）
              * candidate 的 boundary_envs（service / endpoint / SDK）已经消失，
                且新 conversation 确认其已 deprecated

规则：
- “Same task”是指已有 memory 和新 draft 都可以作为同一个未来用户查询的有效答案。
- 如果 solution 不同，优先 UPDATE（不保留历史版本）。
- 如果 task 和 solution 都高度一致，选择 SKIP。
- 只有在存在明确证据表明 candidate 已 invalid/obsolete 时才 DELETE。绝不要仅仅因为
  candidate 看起来“stale”就 DELETE。
- 产生 DELETE 时，输出的 ops 数量可以超过 drafts 数量。

═══════════════════════════════════════════════════════════════════
NEW DRAFTS
═══════════════════════════════════════════════════════════════════
{drafts_block}

═══════════════════════════════════════════════════════════════════
EXISTING CANDIDATES（按每条 draft 的 task similarity 检索）
═══════════════════════════════════════════════════════════════════
{candidates_block}

═══════════════════════════════════════════════════════════════════
OUTPUT（仅输出严格 JSON，不要 markdown）
═══════════════════════════════════════════════════════════════════
{{
  "ops": [
    {{"draft_idx": 0, "action": "ADD"}},
    {{"draft_idx": 1, "action": "UPDATE", "target_experience_id": "exp_xxx", "reason": "..."}},
    {{"draft_idx": 1, "action": "DELETE", "target_experience_id": "exp_yyy", "reason": "user explicitly deprecated Y"}},
    {{"draft_idx": 2, "action": "SKIP",   "reason": "duplicate"}}
  ]
}}

如果没有 drafts，输出 {{"ops": []}}。
"""


FACT_RECONCILE_PROMPT_ZH = """\
你负责维护 session-level WORKING FACTS。每条 statement 都概括一整段 trace/session：
用户的任务、大致方法和结果。它不是一条 atomic claim。

下面每条新的 session fact 都一定会被存储；这不是你要决定的事情。你的唯一任务是识别
task continuation：新 session 是否在继续推进某条已有 session fact 所记录的同一个用户
任务？如果是，就将较旧 fact 标记为 SUPERSEDE，使这些链接为该任务构成跨 session 的
进展链。

只有在存在充分证据同时满足以下条件时，才将已有 fact 标记为 superseded：
  - subjects 匹配：两条记录围绕同一个实体——同一个 person、同一个 file/module、
    同一个 host/service。subject 相同是必要条件，但不是充分条件；并且
  - 用户目标在实质上相同，而不只是处于同一 topic/project；并且
  - 新 trace 在继续、重试、扩展、验证或完成已有 trace 所记录的工作。

以下情况不要 supersede：
  - 两条记录的 subjects 不同。同一 group 中的两个人、同一 module 中的两个 files、
    同一 cluster 中的两个 hosts 是并行关系，不是先后关系：一个人的状态不是另一个人
    状态的新版本。如果 subject 显示为 (unspecified)，退回到只根据 statement 判断。
  - 两次 session 只是提到了相同 file、symbol、component、repository、error 或
    technology，但追求不同的用户目标。
  - 一个任务只是为另一个任务提供 context 或 technique。
  - 关系不确定。应保守判断：INSERT 是安全默认值；合并无关 session 会毁掉它们各自
    独立的任务历史。

把每条 statement 当作有证据边界的文本。不要把其中的 inference 重新解释为已经确定的
cause，也不要把共同的 conjecture/error 当作用户目标相同的证据。你的判断仅涉及 task
continuation；不要“纠正”、补全或润色任何一条 session 记录。

示例：
  existing: “需要修复 CI 的 npm run build；已追踪到 Node 18 下的
             ERR_OSSL_EVP_UNSUPPORTED，workflow 尚未修改。”
  new:      “继续修复同一个 CI build；已将 .github/workflows/ci.yml 中的 Node
             提升到 20，且 npm run build 通过。”
                                                                 → SUPERSEDE

  existing: “需要修复 auth/middleware.ts 中的 JWT expiry handling；已添加
             refresh logic。”
  new:      “需要在 auth/middleware.ts 中添加 performance logging；已引入
             latency metric。”
                                                                 → 两者都保留
            （同一 file/project，不同用户目标）

═══════════════════════════════════════════════════════════════════
NEW SESSION FACTS
═══════════════════════════════════════════════════════════════════
{drafts_block}

═══════════════════════════════════════════════════════════════════
EXISTING SESSION FACTS（按每条新 fact 的 statement similarity 检索）
═══════════════════════════════════════════════════════════════════
{candidates_block}

═══════════════════════════════════════════════════════════════════
OUTPUT（仅输出严格 JSON，不要 markdown）
═══════════════════════════════════════════════════════════════════
{{
  "ops": [
    {{"draft_idx": 0, "supersedes": ["fact_xxx"], "reason": "continues the same CI fix task"}},
    {{"draft_idx": 1, "supersedes": []}}
  ]
}}

只能使用同一个 draft_idx 的 candidate list 中实际出现的 fact ids。
如果任何位置都没有 fact 被 superseded，输出 {{"ops": []}}。
"""


CHAIN_SUMMARY_PROMPT_ZH = """\
working-memory store 中的某个用户任务已跨多个 sessions 推进。下面是该任务进展链中的
session summaries，按从最早到最新排列，最后一条是当前 session。

总结同一个任务如何跨 sessions 推进到当前状态。按时间顺序覆盖每个重要阶段。对每个
阶段，在有信息时保留：实际 action 或 change、其 direct result，以及任何 unresolved
issue 或 limiting condition。最后明确写出当前状态。

规则：
  - 这只是压缩。只能报告 entries 实际陈述的内容；绝不要新增或补全 command、cause、
    motive、action、test result、success state 或 global negative conclusion。
  - 精确保留证据状态：attempted 不等于 completed，observed 不等于 verified，inferred
    不等于 established，unresolved 必须保持 unresolved。保留 uncertainty words 以及
    search/permission/coverage limits。
  - 忠实陈述当前结束状态（completed、partially completed、failed、blocked 或
    still awaiting verification）。绝不要因为某个看似合理的因果故事，或后续 entry
    并未验证的内容而提升状态。
  - 如果 entries 提到 suspected cause 和后续 result，只有某条 entry 直接说明该 cause
    已被 verified 时，才可在两者之间建立因果联系。
  - 保留具体 retrieval anchors：file paths、symbols、commands、error strings、versions、
    config keys/values，以及对进展重要的 numeric values。
  - 对 2-3 代的 chains，不要把进展过度压缩成一句话。适合时优先使用 2-4 个紧凑段落，
    或使用可读性良好的 prose，清楚呈现 task goal、逐阶段 progression 和 current status。
  - 不要机械复制完整 history。在保留重要 actions、direct results 和 leftovers 的同时，
    省略重复及低价值细节。
  - 不要杜撰 stage headings 或 dates。只有 entries 使日期有实际意义时才提及日期；
    单独的 timestamps 是噪声。
  - 如果 entries 说明更早 revisions 已被省略，必须明确指出 earlier history was omitted；
    不要暗示所提供的 entries 是完整历史。
  - 使用与 entries 相同的语言。
  - 不要写前言，也不要用引号包裹输出。

示例
  entries:
    (2026-07-20) 需要修复 CI 的 npm run build；已追踪到 Node 18 下的
                 ERR_OSSL_EVP_UNSUPPORTED，workflow 尚未修改。
    (2026-07-24) 继续修复同一个 CI 问题；已将 .github/workflows/ci.yml 中的 Node
                 提升到 20，但 dependency cache 仍复现旧错误。
    (now)        继续验证同一修复；清除 npm cache 后，npm run build 通过。
  output:
    任务目标是修复 CI 的 npm run build。最初将问题追踪到 Node 18 下的
    ERR_OSSL_EVP_UNSUPPORTED，当时尚未修改 workflow；随后将
    .github/workflows/ci.yml 提升到 Node 20，但 dependency cache 仍使旧错误继续
    出现。最后，清除 npm cache 后 npm run build 通过，因此该 build 修复目前已验证完成。

═══════════════════════════════════════════════════════════════════
ENTRIES
═══════════════════════════════════════════════════════════════════
{chain_block}

═══════════════════════════════════════════════════════════════════
OUTPUT（只输出 summary 本身，不要其他内容）
═══════════════════════════════════════════════════════════════════
"""
