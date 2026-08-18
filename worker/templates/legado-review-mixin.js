/**
 * Legado 段评混入
 *
 * 把这段代码整体粘到你自己的 JS 书源末尾，改掉下面的 REVIEW_API 即可。
 * 三个函数与 App 侧一一对应：
 *   getReviewSummary  章节加载后调用，返回每段的评论数，决定图标画在哪
 *   getReviewDetail   点击段评图标时调用，返回该段的评论列表
 *   getReviewReplies  点「查看更多回复」时调用，按页拉取子评论
 *
 * getReviewSummary 与 getReviewDetail 必须成对存在，缺一个保存时会报配对错误。
 *
 * ── 段落对齐 ──────────────────────────────────────────────────────
 * paraIndex 数的是 App 净化和替换之后的段落，正文第一段为 1，章节标题为 -1。
 * 本混入按同样的规则给正文分段，但如果这本书启用了会「删行」的净化规则或替换规则，
 * 段号就会和 App 对不上，整章段评集体错位。纯字符替换不改变段落数则无影响。
 * 出现错位时，对这本书关掉净化/替换即可。
 *
 * ── 普通规则书源 ──────────────────────────────────────────────────
 * 规则书源拿不到正文，只能查询已有段评，不会触发 AI 生成。
 * 注意：千万不要为了段评给规则书源塞 mainJs——App 里 isJsSource() 只看 mainJs 是否为空，
 * 一旦非空，搜索、目录、正文全部改走 JS 函数，整个书源就废了。规则书源只能用下面的字段。
 *
 * 在书源编辑页「段评」标签页勾选启用，然后填（URL 里的变量要自己编码）：
 *   注意 AnalyzeUrl 的 JS 作用域里只有 book / page / java / source，没有 chapter，
 *   章节标题只能用 java.get("title") 取，写成 chapter.title 会抛异常导致段评静默失败。
 *   reviewSummaryUrl           https://你的域名/review/summary?book={{encodeURIComponent(book.name)}}&author={{encodeURIComponent(book.author)}}&chapter={{encodeURIComponent(java.get("title"))}}&token=你的令牌
 *   summaryListRule            $.list
 *   summaryParagraphIndexRule  $.paraIndex
 *   summaryCountRule           $.count
 *   summaryParagraphDataRule   $.paraData
 *   reviewDetailUrl            https://你的域名/review/detail?para={{paraIndex}}&data={{paraData}}&page={{page}}&token=你的令牌
 *   detailListRule             $.items
 *   detailIdRule               $.id
 *   detailNameRule             $.name
 *   detailBadgeRule            $.badge
 *   detailContentRule          $.content
 *   reviewQuoteUrl             https://你的域名/review/replies?id={{reviewId}}&page={{page}}&token=你的令牌
 *   replyListRule              $.items
 *   replyIdRule                $.id
 *   replyNameRule              $.name
 *   replyContentRule           $.content
 */

var REVIEW_API = "https://your-service.example.com";

/** 服务端配了 review_token 时必须填，否则请求会被拒 */
var REVIEW_TOKEN = "";

/** 统计结果的缓存时长（秒），设为 0 关闭缓存 */
var REVIEW_CACHE_TTL = 3600;

function reviewTokenParam(prefix) {
    return REVIEW_TOKEN ? prefix + "token=" + encodeURIComponent(REVIEW_TOKEN) : "";
}

function getReviewSummary(chapter, book) {
    var cacheKey = "rvsum_" + java.md5Encode16(REVIEW_API + "|" + book.name + "|" + chapter.title);

    if (REVIEW_CACHE_TTL > 0) {
        var cached = cache.get(cacheKey);
        if (cached) {
            try {
                return JSON.parse(cached);
            } catch (e) {
                // 缓存坏了就当没有，继续走网络
            }
        }
    }

    // 服务端要靠正文才能生成评论，这里复用本书源自己的 getContent
    var paragraphs = [];
    try {
        paragraphs = reviewSplitParagraphs(getContent(chapter, book, null));
    } catch (e) {
        // 取不到正文不影响已有批注的显示
    }

    var payload = JSON.stringify({
        book: { name: book.name, author: book.author || "" },
        chapter: { title: chapter.title },
        paragraphs: paragraphs
    });

    var res = java.post(
        REVIEW_API + "/review/summary" + reviewTokenParam("?"),
        payload,
        { "Content-Type": "application/json" }
    );

    var data = JSON.parse(res.body());
    var list = data.list || [];

    // 只缓存有内容的结果，避免把「生成中的空结果」按小时锁住
    if (REVIEW_CACHE_TTL > 0 && list.length > 0) {
        cache.put(cacheKey, JSON.stringify(list), REVIEW_CACHE_TTL);
    }

    return list;
}

function getReviewDetail(chapter, book, paraIndex, paraData, page) {
    var url = REVIEW_API + "/review/detail"
        + "?para=" + paraIndex
        + "&data=" + encodeURIComponent(paraData || "")
        + "&page=" + page
        + reviewTokenParam("&");
    return JSON.parse(java.ajax(url));
}

function getReviewReplies(chapter, book, paraIndex, paraData, reviewId, page) {
    var url = REVIEW_API + "/review/replies"
        + "?id=" + encodeURIComponent(reviewId)
        + "&page=" + page
        + reviewTokenParam("&");
    return JSON.parse(java.ajax(url));
}

/**
 * 按 App 的方式给正文分段：去标签、按换行切、丢掉空行。
 * 返回数组的第 0 项即 paraIndex 为 1 的那一段。
 */
function reviewSplitParagraphs(text) {
    if (!text) return [];

    var plain = String(text)
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*\/\s*(p|div)\s*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

    var lines = plain.split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/^[\s　]+/, "").replace(/[\s　]+$/, "");
        if (line) out.push(line);
    }
    return out;
}
