# Antigravity 项目规则 (Legado-Subscription)

## 核心指令
1.  **Canvas 渲染**: 必须严格遵循同目录下的 [legado_render_skill.md](./legado_render_skill.md) 中的技术规范。任何排版算法的改动必须经过该 Skill 校验。
2.  **排版一致性**: 
    - 优先处理中文避头尾逻辑。
    - 严格对齐 1/10 比例的间距换算。
    - 确保 `textFullJustify` 的空格/字距平摊逻辑正确。
3.  **开发标准**:
    - 注释中必须标注对应 Legado 源码的类名或逻辑来源。
    - 修正代码后必须重新确认是否引入了模糊、偏色或对齐偏移。
