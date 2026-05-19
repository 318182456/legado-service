import React, { useEffect, useRef } from 'react'; // JSX 启用

const POST_PANC = new Set(`，。：？！、”’）》】)\]」}；;·…~～!?,.`.split(""));
const PRE_PANC = new Set(`“‘（《【(\[「{`.split(""));

export class LegadoRenderer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    scale: number = 3;

    constructor(canvasElement: HTMLCanvasElement) {
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext("2d")!;
    }

    /**
     * 严谨解析 Android 的颜色 #AARRGGBB，并可叠加独立的 Alpha 值 (0-100)
     */
    parseAndroidColor(colorStr: string | number, extraAlpha: number = 100): string {
        if (!colorStr) return `rgba(0, 0, 0, 0)`;

        let a = 1,
            r = 0,
            g = 0,
            b = 0;

        // 兼容十进制负数颜色 (Legado 源码中默认颜色有时是 -1)
        if (typeof colorStr === "number" || !isNaN(Number(colorStr))) {
            let colorInt = Number(colorStr);
            if (colorInt === -1) {
                r = 255;
                g = 255;
                b = 255;
                a = 1;
            } else {
                // 处理 Android Int Color: (A << 24) | (R << 16) | (G << 8) | B
                // 转为无符号 32 位整数处理
                const uintColor = colorInt >>> 0;
                a = ((uintColor >> 24) & 0xff) / 255;
                r = (uintColor >> 16) & 0xff;
                g = (uintColor >> 8) & 0xff;
                b = uintColor & 0xff;
            }
        } else {
            let hex = (colorStr as string).replace("#", "");
            if (hex.length === 8) {
                // AARRGGBB
                a = parseInt(hex.substring(0, 2), 16) / 255;
                r = parseInt(hex.substring(2, 4), 16);
                g = parseInt(hex.substring(4, 6), 16);
                b = parseInt(hex.substring(6, 8), 16);
            } else if (hex.length === 6) {
                // RRGGBB
                r = parseInt(hex.substring(0, 2), 16);
                g = parseInt(hex.substring(2, 4), 16);
                b = parseInt(hex.substring(4, 6), 16);
            } else if (hex.length === 3) {
                // RGB
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            }
        }

        // 叠加额外透明度 (如 bgAlpha)
        a = a * (extraAlpha / 100);
        return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
    }

    /**
     * 核心排版：绘制两端对齐的文本 (复刻 Legado 的 Justify 特性)
     */
    drawJustifiedText(
        text: string,
        x: number,
        y: number,
        maxWidth: number,
        isLastLine: boolean,
        letterSpacing: number = 0
    ) {
        const { ctx } = this;
        const words = Array.from(text); // 👑 修正：支持 Emoji 等特殊字符
        if (words.length === 0) return;

        // 如果是段落最后一行，或者是单个字符，采用左对齐
        if (isLastLine || words.length === 1) {
            ctx.fillText(text, x, y);
            return;
        }

        const metrics = ctx.measureText(text);
        // 👑 修正：测算宽度时必须严格包含字距补偿
        const textWidth = metrics.width + (words.length - 1) * letterSpacing;

        const extraSpace = maxWidth - textWidth;

        if (extraSpace < 0 || extraSpace > maxWidth * 0.4) {
            ctx.fillText(text, x, y);
            return;
        }

        const spacePerChar = extraSpace / (words.length - 1);

        let currentX = x;
        for (let i = 0; i < words.length; i++) {
            ctx.fillText(words[i], currentX, y);
            // 👑 修正：每个字符的步进 = 字符自身宽度 + 字距 + 两端对齐增量
            currentX += ctx.measureText(words[i]).width + letterSpacing + spacePerChar;
        }
    }

    // 👑 核心工具：获取精确的字体高度测算 (对齐 Android Paint.FontMetrics)
    getRealFontMetrics(fontSize: number, fontStack: string, isBold: boolean) {
        const { ctx } = this;
        const oldFont = ctx.font;
        ctx.font = `${isBold ? "bold" : "normal"} ${fontSize}px ${fontStack}`;
        const m = ctx.measureText("国Agy");

        // 👑 修正：使用 fontBoundingBox 以包含字体的建议留白
        // Android 的 Paint.FontMetrics 通常比 Web 的 actualBoundingBox 宽裕得多
        // 经过对齐实验，CJK 字体在 Android 下的 LineHeight 基数约是 FontSize 的 1.35 倍
        const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || fontSize * 1.1;
        const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || fontSize * 0.25;

        ctx.font = oldFont;
        // 关键：将基准高度设为 fontSize 的 1.35 倍，这才是 Android 渲染的核心“松散感”来源
        const baseHeight = ascent + descent;
        const finalHeight = Math.max(baseHeight, fontSize * 1.35);

        return { ascent, descent, fontHeight: finalHeight };
    }

    drawStatusBar(theme: any) {
        const { ctx, canvas, scale } = this;
        if (theme.hideStatusBar) return;

        const h = 38 * scale;
        const fontSize = 12 * scale;
        ctx.font = `600 ${fontSize}px sans-serif`;

        const iconColor = theme.darkStatusIcon ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.7)";
        ctx.fillStyle = iconColor;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        const padding = 16 * scale;
        const centerY = h / 2;

        // 时间
        ctx.fillText("16:10", padding, centerY);

        // 右侧图标 (模拟: Wifi, 信号, 电池)
        ctx.textAlign = "right";
        const rightEdge = canvas.width - padding;

        // 模拟电池图标
        const batW = 18 * scale;
        const batH = 9 * scale;
        const batX = rightEdge - batW;
        const batY = centerY - batH / 2;
        ctx.lineWidth = 1 * scale;
        ctx.strokeStyle = iconColor;
        ctx.strokeRect(batX, batY, batW, batH);
        ctx.fillRect(
            batX + 2 * scale,
            batY + 2 * scale,
            (batW - 4 * scale) * 0.8,
            batH - 4 * scale
        );

        // 5G 文本
        ctx.font = `italic bold ${10 * scale}px sans-serif`;
        ctx.fillText("5G", batX - 6 * scale, centerY);

        // 信号 (4格)
        const sigX = batX - 22 * scale;
        for (let i = 1; i <= 4; i++) {
            const barH = i * 2 * scale;
            ctx.fillRect(sigX + (i - 1) * 3 * scale, centerY + 4 * scale - barH, 2 * scale, barH);
        }
    }

    drawNavigationBar(theme: any) {
        const { ctx, canvas, scale } = this;
        if (theme.hideNavigationBar) return;

        // 👑 修正：底部导航栏只保留一个极淡的 Home 指示条，不添加任何背景色
        const h = 24 * scale;
        const barW = 100 * scale;
        const barH = 4 * scale;
        const x = (canvas.width - barW) / 2;
        const y = canvas.height - h / 2 - barH / 2;

        ctx.fillStyle = theme.darkStatusIcon ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.15)";
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, barW, barH, 2 * scale);
        } else {
            ctx.rect(x, y, barW, barH);
        }
        ctx.fill();
    }

    async renderTheme(
        theme: any,
        options: {
            bgImage?: HTMLImageElement | null;
            getTipText: (type: number) => string;
            PREVIEW_TITLE: string;
            PREVIEW_PARAS: string[];
        }
    ) {
        if (!theme) return;
        const { ctx, canvas } = this;
        const scale = this.scale;

        // 👑 修正：使用 clearRect 彻底清空画布，不再填充任何底色，确保透明度生效
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // --- 1. 渲染背景 ---
        if (theme.bgType === 2 && options.bgImage) {
            ctx.globalAlpha = (theme.bgAlpha ?? 100) / 100;

            // 👑 修正：使用 Cover 模式绘制背景，防止拉伸变形
            const img = options.bgImage;
            const imgRatio = img.width / img.height;
            const canvasRatio = canvas.width / canvas.height;
            let drawW, drawH, drawX, drawY;

            if (imgRatio > canvasRatio) {
                drawH = canvas.height;
                drawW = img.width * (canvas.height / img.height);
                drawX = (canvas.width - drawW) / 2;
                drawY = 0;
            } else {
                drawW = canvas.width;
                drawH = img.height * (canvas.width / img.width);
                drawX = 0;
                drawY = (canvas.height - drawH) / 2;
            }

            ctx.drawImage(img, drawX, drawY, drawW, drawH);
            ctx.globalAlpha = 1.0;
        } else {
            ctx.fillStyle = this.parseAndroidColor(
                theme.bgStr || "#FFFFFFFF",
                theme.bgAlpha ?? 100
            );
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // --- 绘制系统 UI ---
        this.drawStatusBar(theme);
        this.drawNavigationBar(theme);

        // --- 2. 映射排版属性 ---
        const pL = (theme.paddingLeft ?? 16) * scale;
        const pR = (theme.paddingRight ?? 16) * scale;
        const pT = (theme.paddingTop ?? 15) * scale;
        const pB = (theme.paddingBottom ?? 15) * scale;

        const textSize = (theme.textSize ?? 20) * scale;
        const titleSize = (theme.textSize + (theme.titleSize ?? 0)) * scale;

        const fontStack = theme.textFont
            ? `"${theme.textFont
                  .split("/")
                  .pop()
                  .replace(/\.[^.]+$/, "")}", sans-serif`
            : "sans-serif";

        // 👑 修正：支持 Legado 的三种粗细模式 (0: 正常, 1: 粗体, 2: 细体)
        let fontWeight = "normal";
        if (theme.textBold === 1) fontWeight = "bold";
        else if (theme.textBold === 2) fontWeight = "100"; // 细体

        // 👑 核心修正：字距 EM 转换逻辑
        const letterSpacing = (theme.letterSpacing ?? 0.04) * textSize * 0.85;

        // 👑 回退：恢复比例模式的行高与段距计算
        const metrics = this.getRealFontMetrics(textSize, fontStack, !!theme.textBold);
        const lineHeight = metrics.fontHeight * ((theme.lineSpacingExtra ?? 12) / 10);
        const paragraphSpacing = metrics.fontHeight * ((theme.paragraphSpacing ?? 5) / 10);

        const textColor = this.parseAndroidColor(theme.textColor ?? "#FF3E3D3B");

        // 👑 修正：Legado 中 tipColor 为 0 时表示跟随正文颜色 (应用 60% 透明度)
        let tipColor =
            theme.tipColor !== undefined && theme.tipColor !== 0
                ? this.parseAndroidColor(theme.tipColor)
                : this.parseAndroidColor(theme.textColor ?? "#FF3E3D3B", 60);

        // --- 3. 绘制 Header & Footer ---
        ctx.font = `normal ${11 * scale}px ${fontStack}`;
        ctx.fillStyle = tipColor;
        ctx.textBaseline = "middle";

        const statusBarH = (theme.hideStatusBar ? 0 : 38) * scale;
        const navBarH = (theme.hideNavigationBar ? 0 : 24) * scale;

        // 👑 修正：Legado 分割线颜色回退逻辑
        // 如果 tipDividerColor 为 -1 (Color.WHITE) 或未定义，通常应跟随 tipColor 产生融合感
        const dividerColor =
            theme.tipDividerColor !== undefined && theme.tipDividerColor !== -1
                ? this.parseAndroidColor(theme.tipDividerColor)
                : tipColor;

        // Header
        let headerBottom = statusBarH;
        // 👑 修正：headerMode 逻辑
        // 0: 当状态栏显示时隐藏页眉 (hide_when_status_bar_show)
        // 1: 始终显示
        // 2: 隐藏
        const shouldShowHeader =
            theme.headerMode === 1 || (theme.headerMode === 0 && theme.hideStatusBar);

        if (shouldShowHeader) {
            const hPaddingT = (theme.headerPaddingTop ?? 0) * scale;
            const hPaddingB = (theme.headerPaddingBottom ?? 1) * scale;
            const hPaddingL = (theme.headerPaddingLeft ?? 24) * scale;
            const hPaddingR = (theme.headerPaddingRight ?? 24) * scale;
            // 👑 修正：页眉文字的中心 Y 坐标计算，确保 padding 被正确应用
            const headerY = statusBarH + hPaddingT + 8 * scale;

            ctx.textAlign = "left";
            ctx.fillText(options.getTipText(theme.tipHeaderLeft ?? 2), hPaddingL, headerY);
            ctx.textAlign = "center";
            ctx.fillText(options.getTipText(theme.tipHeaderMiddle ?? 0), canvas.width / 2, headerY);
            ctx.textAlign = "right";
            ctx.fillText(
                options.getTipText(theme.tipHeaderRight ?? 3),
                canvas.width - hPaddingR,
                headerY
            );

            headerBottom = headerY + 8 * scale + hPaddingB;
            if (theme.showHeaderLine) {
                ctx.beginPath();
                ctx.moveTo(0, headerBottom);
                ctx.lineTo(canvas.width, headerBottom);
                ctx.strokeStyle = dividerColor;
                ctx.lineWidth = 0.5 * scale;
                ctx.globalAlpha = 0.2;
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            }
        }

        // Footer
        let footerTop = canvas.height - navBarH;
        if (theme.footerMode !== 1) {
            const fPaddingT = (theme.footerPaddingTop ?? 0) * scale;
            const fPaddingB = (theme.footerPaddingBottom ?? 6) * scale;
            const fPaddingL = (theme.footerPaddingLeft ?? 24) * scale;
            const fPaddingR = (theme.footerPaddingRight ?? 24) * scale;
            
            // 👑 修正：页脚 Y 坐标计算
            const footerY = canvas.height - navBarH - fPaddingB - 12 * scale;

            ctx.textAlign = "left";
            ctx.fillText(options.getTipText(theme.tipFooterLeft ?? 1), fPaddingL, footerY);
            ctx.textAlign = "center";
            ctx.fillText(options.getTipText(theme.tipFooterMiddle ?? 0), canvas.width / 2, footerY);
            ctx.textAlign = "right";
            ctx.fillText(
                options.getTipText(theme.tipFooterRight ?? 6),
                canvas.width - fPaddingR,
                footerY
            );

            // 👑 修正：页脚线的位置应包含 fPaddingT
            footerTop = footerY - 15 * scale - fPaddingT;
            if (theme.showFooterLine) {
                ctx.beginPath();
                ctx.moveTo(0, footerTop);
                ctx.lineTo(canvas.width, footerTop);
                ctx.strokeStyle = dividerColor;
                ctx.lineWidth = 0.5 * scale;
                ctx.globalAlpha = 0.2;
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            }
        }

        // --- 4. 绘制正文 (带裁切范围) ---
        const drawWidth = canvas.width - pL - pR;
        // 👑 回退：恢复避让页眉的起始点
        let currentY = headerBottom + pT;

        ctx.save();
        ctx.beginPath();
        // 👑 回退：恢复避让页眉页脚的裁切范围
        ctx.rect(0, headerBottom, canvas.width, Math.max(0, footerTop - headerBottom));
        ctx.clip();

        // > 绘制标题
        if (theme.titleMode !== 2) {
            const tMetrics = this.getRealFontMetrics(titleSize, fontStack, true);
            const tLineHeight = tMetrics.fontHeight * ((theme.lineSpacingExtra ?? 12) / 10);

            currentY += (theme.titleTopSpacing ?? 8) * scale;
            ctx.font = `bold ${titleSize}px ${fontStack}`;
            ctx.fillStyle = textColor;
            // 👑 修正：支持居中标题模式
            ctx.textAlign = theme.titleMode === 1 ? "center" : "left";
            ctx.textBaseline = "top";

            const titleX = theme.titleMode === 1 ? canvas.width / 2 : pL;
            const titleLines = this.layoutLines(
                options.PREVIEW_TITLE,
                drawWidth,
                0,
                titleSize,
                fontStack,
                true,
                letterSpacing
            );
            titleLines.forEach(line => {
                ctx.fillText(line, titleX, currentY);
                currentY += tLineHeight;
            });

            // 👑 核心修正：标题底边距 = 段间距 + 标题独有下边距
            currentY += paragraphSpacing + (theme.titleBottomSpacing ?? 0) * scale;
        }

        // > 绘制段落
        ctx.font = `${fontWeight} ${textSize}px ${fontStack}`;
        ctx.fillStyle = textColor;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        const indent = theme.paragraphIndent ?? "　　";

        for (const paragraph of options.PREVIEW_PARAS) {
            const fullPara = indent + paragraph;
            const lines = this.layoutLines(
                fullPara,
                drawWidth,
                0,
                textSize,
                fontStack,
                !!theme.textBold,
                letterSpacing
            );

            for (let index = 0; index < lines.length; index++) {
                const isLastLine = index === lines.length - 1;
                // 👑 回退：恢复避让页脚的判定
                if (currentY + metrics.fontHeight > footerTop - pB) break;

                this.drawJustifiedText(
                    lines[index],
                    pL,
                    currentY,
                    drawWidth,
                    isLastLine,
                    letterSpacing
                );

                // 👑 修正：支持下划线模式 (underline)
                if (theme.underline) {
                    ctx.beginPath();
                    ctx.moveTo(pL, currentY + metrics.fontHeight + 1 * scale);
                    ctx.lineTo(pL + drawWidth, currentY + metrics.fontHeight + 1 * scale);
                    ctx.strokeStyle = textColor;
                    ctx.lineWidth = 1 * scale;
                    ctx.globalAlpha = 0.5;
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                }

                currentY += lineHeight;
            }
            currentY += paragraphSpacing;
            if (currentY > footerTop - pB) break;
        }

        ctx.restore();
    }

    /**
     * 增强版换行算法，集成避头尾规则
     */
    layoutLines(
        text: string,
        maxW: number,
        firstIndent: number,
        fontSize: number,
        fontStack: string,
        isBold: boolean,
        letterSpacing: number = 0
    ): string[] {
        const { ctx } = this;
        const oldFont = ctx.font;
        ctx.font = `${isBold ? "bold" : "normal"} ${fontSize}px ${fontStack}`;

        const lines: string[] = [];
        let currentLine = "";

        const chars = Array.from(text);
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const testLine = currentLine + char;
            const metrics = ctx.measureText(testLine);
            // 👑 修正：换行判定必须包含字距
            const testW = metrics.width + (testLine.length - 1) * letterSpacing;

            if (testW > maxW && currentLine.length > 0) {
                if (POST_PANC.has(char) && currentLine.length > 1) {
                    const lastChar = currentLine.slice(-1);
                    currentLine = currentLine.slice(0, -1);
                    lines.push(currentLine);
                    currentLine = lastChar + char;
                } else if (PRE_PANC.has(currentLine.slice(-1)) && currentLine.length > 1) {
                    const lastChar = currentLine.slice(-1);
                    currentLine = currentLine.slice(0, -1);
                    lines.push(currentLine);
                    currentLine = lastChar + char;
                } else {
                    lines.push(currentLine);
                    currentLine = char;
                }
            } else {
                currentLine = testLine;
            }
        }

        if (currentLine) lines.push(currentLine);
        return lines;
    }

    /**
     * 👑 核心优化：生成压缩后的缩略图
     * 将 3x DPI 的画布缩小到 1/6 (约 360px 宽)，并使用 webp 进一步压缩体积
     */
    getThumbnail() {
        try {
            const thumbWidth = 360;
            const thumbHeight = (this.canvas.height / this.canvas.width) * thumbWidth;

            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = thumbWidth;
            tempCanvas.height = thumbHeight;
            const tempCtx = tempCanvas.getContext("2d");

            if (tempCtx) {
                tempCtx.drawImage(this.canvas, 0, 0, thumbWidth, thumbHeight);
                // 使用 webp 格式，质量设为 0.7，体积通常在 10-20KB 左右，非常适合数据库存储
                return tempCanvas.toDataURL("image/webp", 0.7);
            }
            return this.canvas.toDataURL("image/jpeg", 0.5);
        } catch (e) {
            console.error("生成缩略图失败 (可能存在跨域图片污染):", e);
            return "";
        }
    }
}

/**
 * 👑 React 组件包装器：让 LegadoRenderer 可以在 React 中像普通组件一样使用
 */
export const LegadoRendererComponent: React.FC<{
    config: any;
    fontFamily?: string;
    bgBase64?: string;
    className?: string;
    style?: React.CSSProperties;
}> = ({ config, fontFamily = 'sans-serif', bgBase64, className, style }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current || !config) return;

        const canvas = canvasRef.current;
        const renderer = new LegadoRenderer(canvas);
        
        const PREVIEW_TITLE = "预览效果演示";
        const PREVIEW_PARAS = [
            "排版预览演示：这是第一段正文，用于检查字距、行距以及段落间距。Legado 的排版引擎能够自动处理避头尾规则。",
            "这是第二段正文。通过实时渲染，您可以立即看到调整参数后的视觉变化，确保在 App 中拥有最佳阅读体验。"
        ];

        const render = async () => {
            let bgImg: HTMLImageElement | null = null;
            if (bgBase64) {
                bgImg = new Image();
                bgImg.src = bgBase64;
                try {
                    await new Promise((resolve, reject) => {
                        bgImg!.onload = resolve;
                        bgImg!.onerror = reject;
                        // 超时处理
                        setTimeout(resolve, 2000);
                    });
                } catch (e) {
                    bgImg = null;
                }
            }

            renderer.renderTheme(config, {
                bgImage: bgImg,
                getTipText: (type) => {
                    const texts: any = {
                        1: "12%", 2: "书名", 3: "章节名", 4: "16:10", 6: "1/2", 0: ""
                    };
                    return texts[type] || "";
                },
                PREVIEW_TITLE,
                PREVIEW_PARAS
            });
        };

        render();
    }, [config, fontFamily, bgBase64]);

    return (
        <canvas 
            ref={canvasRef} 
            width={1080} // 默认 1080p 宽度
            height={2280} // 默认长比例
            className={className}
            style={{ width: '100%', height: '100%', display: 'block', ...style }}
        />
    );
};
