# Legado 渲染引擎技术规范 (Skill)

本规范定义了 Legado (阅读) Android 端的原生排版与渲染逻辑，用于指导 Canvas 模拟器的实现，确保 Web 端的预览效果与手机端 100% 一致。

## 1. 基础物理单位
- **DPI 模拟**: 所有 `padding`, `spacing`, `margin` 在 Legado 中均为 `dp` 单位。在 Web 预览中应使用 `dpToPx` 进行转换。
- **字体大小**: `textSize` 为 `sp` 单位。标题字号计算公式为 `titlePaint.textSize = (textSize + titleSize).spToPx()`。

## 2. 核心间距算法
- **行间距 (lineSpacingExtra)**: 
  `间距增量 = 行高 * (configValue / 10.0)`
  注意：这是在标准字高基础上的额外增量。
- **段间距 (paragraphSpacing)**: 
  `段落增量 = 行高 * (configValue / 10.0)`
- **字间距 (letterSpacing)**: 
  Legado 使用 Android `Paint.setLetterSpacing(float)`，单位为 `em`。
  `实际像素增量 = letterSpacing * textSize`。

## 3. 中文排版禁则 (ZhLayout)
为了符合中文排版习惯，必须处理避头尾逻辑：
- **行首禁入 (Post-Punctuation)**: `，。：？！、”’）》】」；` 等标点不能出现在行首。
- **行尾禁入 (Pre-Punctuation)**: `“（《【‘「` 等标点不能出现在行尾。
- **处理方式**: 当检测到违反禁则时，应将前一个字符或标点强行拉至下一行（`BREAK_ONE_CHAR`）。

## 4. 两端对齐算法 (Full Justify)
当开启 `textFullJustify` 时：
1. 计算行剩余宽度 `residualWidth = visibleWidth - naturalLineWidth`。
2. **空格优先**: 如果行内包含空格，优先将 `residualWidth` 平摊给所有空格。
3. **字间距平摊**: 如果无空格，则将 `residualWidth` 平摊给行内所有字符间的缝隙。
4. **末行例外**: 段落最后一行不执行两端对齐，使用自然排列。

## 5. 提示信息渲染 (ReadTipConfig)
- **页眉页脚**: 
  - `globalAlpha` 约为 0.85-0.9。
  - `tipColor` 用于文字和分割线。
- **状态栏**:
  - `darkStatusIcon` 决定系统图标颜色。
  - 隐藏状态栏时，页眉应上移（通常补偿 20-25dp）。

## 6. 背景渲染
- `bgAlpha` 仅作用于背景图 (`bgType: 2`)。
- 背景图应使用 `CenterCrop` 模式填充。
