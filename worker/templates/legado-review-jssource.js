/**
 * 带段评的 Legado JS 书源模板
 *
 * 段评三函数已经写好，不用动。你只需要填 search / getChapters / getContent 三处
 * 站点规则，以及顶部 config 里的站点地址。
 *
 * 为什么必须是 JS 书源：App 里 isJsSource() 只看 mainJs 是否为空，段评走的是
 * if (isJsSource()) 用 JS 函数 else 读 ruleReview——两条路互斥。而只有 JS 书源
 * 能在 getReviewSummary 里拿到正文投喂给服务端，规则书源做不到，也就没有 AI 段评。
 *
 * 提示：JS 书源里没有 java.getString / java.getElements（那些是 AnalyzeRule 的方法，
 * 只在规则书源的解析上下文可用），所以解析要自己用 Jsoup 或正则写。
 */

var config = {
    bookSourceUrl: "https://example.com",
    bookSourceName: "我的段评书源",
    bookSourceType: 0,
    bookSourceGroup: "段评",
    bookSourceComment: "带 AI 段评与个人批注",
    loginUi: [],
    exploreUrl: [],
    lastUpdateTime: 0
};

var Jsoup = org.jsoup.Jsoup;

// ─── 站点规则：以下三个函数按你的目标站点填写 ─────────────────────

/**
 * 搜索。返回数组，每项至少要有 name 和 bookUrl。
 */
function search(key, page) {
    var html = java.ajax(config.bookSourceUrl + "/search?q=" + encodeURIComponent(key) + "&page=" + page);
    var doc = Jsoup.parse(html);
    var books = [];

    var items = doc.select("div.book-item");          // ← 改成站点的列表选择器
    for (var i = 0; i < items.size(); i++) {
        var el = items.get(i);
        books.push({
            name: el.select("h3 a").text(),            // ← 书名
            author: el.select("span.author").text(),   // ← 作者
            bookUrl: el.select("h3 a").attr("abs:href"),
            coverUrl: el.select("img").attr("abs:src"),
            intro: el.select("p.intro").text()
        });
    }
    return books;
}

/**
 * 目录。数组顺序即章节顺序，title 和 url 必填。
 */
function getChapters(book) {
    var html = java.ajax(book.tocUrl || book.bookUrl);
    var doc = Jsoup.parse(html);
    var chapters = [];

    var links = doc.select("div.chapter-list a");      // ← 改成站点的目录选择器
    for (var i = 0; i < links.size(); i++) {
        var a = links.get(i);
        chapters.push({ title: a.text(), url: a.attr("abs:href") });
    }
    return chapters;
}

/**
 * 正文。返回文本，段落之间用 \n 分隔——段评就是按这个分段对齐的。
 * 返回空字符串视为失败。
 */
function getContent(chapter, book, nextChapterUrl) {
    var html = java.ajax(chapter.url);
    var doc = Jsoup.parse(html);

    var body = doc.select("div#content");              // ← 改成站点的正文选择器
    if (body.isEmpty()) return "";

    // 保留段落结构：把 <br> 和 </p> 都转成换行
    var text = body.html()
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*\/\s*p\s*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

    return text;
}

// ─── 段评：以下不用改 ─────────────────────────────────────────────

var REVIEW_API = "https://your-service.example.com";

/** 服务端配了 review_token 时必须填 */
var REVIEW_TOKEN = "";

/** 统计结果缓存时长（秒），设为 0 关闭缓存 */
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

    // 服务端要靠正文才能生成评论，这里复用上面的 getContent
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
 * 返回数组第 0 项即 paraIndex 为 1 的那一段，章节标题是 -1。
 *
 * 注意：如果这本书开了会「删行」的净化或替换规则，App 侧段落数会变，
 * 段号就对不上，整章段评集体错位。纯字符替换不改段落数则无影响。
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
