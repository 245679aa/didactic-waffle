// api/code.js  —— CommonJS 版本（全 ASCII，无全角字符）
const CODE_REGEX = /(?<!\d)(\d{4,8})(?!\d)/;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*"; // 需要锁域时在 Vercel 环境变量里设置

async function getAuthToken() {
    const url = "https://api.mail.cx/api/v1/auth/authorize_token";
    const resp = await fetch(url, { method: "POST", headers: { accept: "application/json" } });
    if (!resp.ok) throw new Error("authorize_token failed: HTTP " + resp.status);
    const text = (await resp.text()).trim();
    return text.replace(/^"+|"+$/g, "");
}

function pickLatestMailId(mails) {
    if (!Array.isArray(mails) || mails.length === 0) return null;

    // 如果都有 posix-millis，用最大值；否则退回第 0 封
    let allHaveMillis = true;
    for (const m of mails) {
        if (typeof m["posix-millis"] !== "number") {
            allHaveMillis = false;
            break;
        }
    }
    if (!allHaveMillis) return mails[0] && mails[0].id ? mails[0].id : null;

    let latest = mails[0];
    for (let i = 1; i < mails.length; i++) {
        const cur = mails[i];
        if (cur["posix-millis"] > latest["posix-millis"]) latest = cur;
    }
    return latest && latest.id ? latest.id : null;
}

async function getEmailId(email, token) {
    const encoded = encodeURIComponent(email);
    const url = "https://api.mail.cx/api/v1/mailbox/" + encoded;
    const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!resp.ok) throw new Error("list mailbox failed: HTTP " + resp.status);
    const mails = await resp.json();
    return pickLatestMailId(mails);
}

// 将 UTC ISO 字符串格式化为北京时间 "YYYY-MM-DD HH:mm:ss"
function formatToBeijing(isoUtc) {
    if (!isoUtc) return "";
    const d = new Date(isoUtc);
    if (isNaN(d)) return "";
    const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).formatToParts(d);

    const map = {};
    for (const p of parts) map[p.type] = p.value;
    // 注意：formatToParts 的 month/day/hour 等均已两位数
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

// 读取单封邮件并提取验证码 + 主题 + 时间
async function getMailDetails(email, mailId, token) {
    const encoded = encodeURIComponent(email);
    const url = "https://api.mail.cx/api/v1/mailbox/" + encoded + "/" + mailId;
    const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!resp.ok) throw new Error("get mail failed: HTTP " + resp.status);
    const mail = await resp.json();

    const subject = (mail && mail.subject) || "";
    const dateUtc = (mail && mail.date) || ""; // 例如：2025-09-15T03:06:49.838978209Z
    const posixMillis = (mail && mail["posix-millis"]) || null;

    const text = ((mail && mail.body && mail.body.text) || "").trim();
    const html = ((mail && mail.body && mail.body.html) || "").trim();
    let m = text.match(CODE_REGEX);
    if (!m) m = html.match(CODE_REGEX);
    const code = m ? m[1] : null;

    const dateBeijing = formatToBeijing(dateUtc);

    // 可选：也带上原始头部 Date（如果你需要展示服务端写入的字符串）
    const headerDate = (mail && mail.header && Array.isArray(mail.header.Date) && mail.header.Date[0]) || "";

    return { code, subject, dateUtc, dateBeijing, posixMillis, headerDate };
}

// 轮询 5 次，每次 3s；适合“刚发来，还没入库”的情况
async function pollLatest(email, token, tries = 5, intervalMs = 3000) {
    for (let i = 0; i < tries; i++) {
        const mailId = await getEmailId(email, token);
        if (mailId) {
            const details = await getMailDetails(email, mailId, token);
            if (details && details.code) {
                return { mailId, ...details };
            }
        }
        if (i < tries - 1) await new Promise(function (r) { setTimeout(r, intervalMs); });
    }
    return {
        mailId: null， code: null， subject: ""， dateUtc: ""， dateBeijing: ""，
        posixMillis: null， headerDate: ""
    };
}

module。exports = async function handler(req， res) {
    try {
        // CORS
        res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
        res。setHeader("Access-Control-Allow-Methods"， "GET, OPTIONS");
        res。setHeader("Access-Control-Allow-Headers"， "Content-Type");
        if (req。method === "OPTIONS") return res。status(204)。end();
        if (req。method !== "GET") {
            return res.status(405).json({ ok: false, error: "Method Not Allowed" });
        }

        const email = ((req。query。email || "") + "")。trim();
        if (!email) return res.status(400).json({ ok: false, error: "缺少 email 参数" });

        const token = await getAuthToken();
        const result = await pollLatest(email， token, 5, 3000);

        if (!result.mailId) {
            return res。status(404)。json({ ok: false， email， error: "未找到最新邮件（邮箱可能无新邮件）" });
        }
        if (!result.code) {
            return res。status(404)。json({
                ok: false，
                email，
                mail_id: result。mailId，
                subject: result。subject，
                date_utc: result。dateUtc，
                date_beijing: result.dateBeijing, // ★ 北京时间
                posix_millis: result.posixMillis,
                header_date: result.headerDate,
                error: "未在正文中提取到 4–8 位验证码"
            });
        }

        return res。status(200)。json({
            ok: true，
            email，
            mail_id: result。mailId，
            code: result。code，
            subject: result。subject，
            date_utc: result。dateUtc，         // 保留原始 UTC，便于核对
            date_beijing: result.dateBeijing, // ★ 前端展示用的北京时间
            posix_millis: result.posixMillis,
            header_date: result.headerDate
        });
    } catch (e) {
        return res。status(500)。json({ ok: false， error: (e && e.message) ? e.message : "服务异常" });
    }
};
