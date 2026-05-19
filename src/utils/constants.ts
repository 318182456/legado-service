export const CANVAS_BASE_WIDTH = 360;
export const CANVAS_BASE_HEIGHT = 640;

// Legado 内部大部分参数是 dp，这里模拟一个比例
// 假设预览区域是一个标准的 360dp 宽度设备
export const DP_RATIO = 1.0; 
export const dpToPx = (dp: number) => dp * DP_RATIO;

export const PREVIEW_TITLE = "第1章 001章重生、穿越、以及智障系统";

export const PREVIEW_PARAS = [
    "“路克，你个懒蛋，还没穿好衣服么？再不下来，我就让你光着屁股去参加毕业舞会。”",
    "罗伯特-葛瑞森坐在敞开的驾驶座上，探出头朝楼上喊了一声，巨大的嗓门似乎把小楼的玻璃都震动了似的。",
    "片刻后，一声不比他刚才那声小多少的大喊响起在楼上：“W！T！H！？”（什么鬼？）",
    "罗伯特顿时火冒三丈，跳下F150的驾驶座，快步地冲进了小楼中。",
    "然后，就是一阵咚咚咚的上楼声，再是砰地开门声。",
    "“啊，路克，你这死小子怎么了？”罗伯特的大喊再次响起，随后由是一个女声响起。",
    "一分钟后，罗伯特背着一个少年从楼中冲了出来，后面是一个神色慌张的中年女人，手上还拉着一个五岁小男孩。",
    "凯瑟琳，你自己开车带约瑟夫跟着过来，路上小心，不要急。"
];

export const getTipText = (type: number) => {
    const labelMap: Record<number, string> = {
        7: "影视世界当神探",
        1: PREVIEW_TITLE,
        2: "11:00",
        3: "■",
        10: "69%",
        4: "1",
        5: "60.5%",
        11: "1/13",
        6: "1/13 60.5%",
        8: "11:00 ■",
        9: "11:00 69%"
    };
    return labelMap[type] || "";
};
