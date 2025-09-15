// api/code.js  —— CommonJS 版本（全 ASCII，无全角字符）
const CODE_REGEX = /(?<!\d)(\d{4,8})(?!\d)/;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*"; // 需要锁域时在 Vercel 环境变量里设置

async function getAuthToken() {
  const url = "https://api.mail.cx/api/v1/auth/authorize_token";
  const resp = await fetch(url， { method: "POST", headers: { accept: "application/json" } });
  if (!resp.ok) throw new 错误("authorize_token failed: HTTP " + resp.status);
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
  for (let i = 1; i < mails。length; i++) {
    const cur = mails[i];
    if (cur["posix-millis"] > latest["posix-millis"]) latest = cur;
  }
  return latest && latest.id ? latest.id : null;
}

async function getEmailId(email， token) {
  const encoded = encodeURIComponent(email);
  const url = "https://api.mail.cx/api/v1/mailbox/" + encoded;
  const resp = await fetch(url,{ headers: { Authorization: "Bearer " + token } });
  if (!resp.ok) throw new 错误("list mailbox failed: HTTP " + resp.status);
  const mails = await resp。json();
  return pickLatestMailId(mails);
}

async function getVerificationCode(email, mailId, token) {
  const encoded = encodeURIComponent(email);
  const url = "https://api.mail.cx/api/v1/mailbox/" + encoded + "/" + mailId;
  const resp = await fetch(url,{ headers: { Authorization: "Bearer " + token } });
  if (!resp。ok) throw new 错误("get mail failed: HTTP " + resp。status);
  const mail = await resp.json();
  const text = ((mail && mail.body && mail.body.text) || "").trim();
  const html = ((mail && mail.body && mail。body.html) || "").trim();
  let m = text.match(CODE_REGEX);
  if (!m) m = html.match(CODE_REGEX);
  return m ? m[1] : null;
}

// 轮询 5 次，每次 3s；适合“刚发来，还没入库”的情况
async function pollLatestCode(email, token, tries = 5, intervalMs = 3000) {
  for (let i = 0; i < tries; i++) {
    const mailId = await getEmailId(email, token);
    if (mailId) {
      const code = await getVerificationCode(email, mailId, token);
      if (code) return { mailId, code };
    }
    if (i < tries - 1) await new Promise(function (r) { setTimeout(r, intervalMs); });
  }
  return { mailId: null, code: null };
}

module.exports = async function handler(req, res) {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const email = ((req.query.email || "") + "").trim();
    if (!email) return res.status(400).json({ ok: false, error: "缺少 email 参数" });

    const token = await getAuthToken();
    const result = await pollLatestCode(email, token, 5, 3000);

    if (!result.mailId) return res.status(404).json({ ok: false, email, error: "未找到最新邮件（邮箱可能无新邮件）" });
    if (!result.code)   return res.status(404).json({ ok: false, email, mail_id: result.mailId, error: "未在正文中提取到 4–8 位验证码" });

    return res.status(200).json({ ok: true, email, mail_id: result.mailId, code: result.code });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? e.message : "服务异常" });
  }
};
