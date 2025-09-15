// api/code.js
const CODE_REGEX = /(?<!\d)(\d{4,8})(?!\d)/;

async function getAuthToken() {
  const url = "https://api.mail.cx/api/v1/auth/authorize_token";
  const resp = await fetch(url, { method: "POST", headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`authorize_token failed: ${resp.status}`);
  const text = (await resp.text()).trim();
  return text.replace(/^"+|"+$/g, ""); // 去掉两侧引号
}

async function getEmailId(email, token) {
  const encoded = encodeURIComponent(email);
  const url = `https://api.mail.cx/api/v1/mailbox/${encoded}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`list mailbox failed: ${resp.status}`);
  const mails = await resp.json();
  return Array.isArray(mails) && mails.length ? mails[0].id : null;
}

async function getVerificationCode(email, mailId, token) {
  const encoded = encodeURIComponent(email);
  const url = `https://api.mail.cx/api/v1/mailbox/${encoded}/${mailId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`get mail failed: ${resp.status}`);
  const mail = await resp.json();
  const text = (mail?.body?.text || "").trim();
  const html = (mail?.body?.html || "").trim();
  let m = text.match(CODE_REGEX);
  if (!m) m = html.match(CODE_REGEX);
  return m ? m[1] : null;
}

// 简单轮询：最多 5 次，每次间隔 3 秒，用于“刚发来邮件还没入库”的情况
async function pollLatestCode(email, token, tries = 5, intervalMs = 3000) {
  for (let i = 0; i < tries; i++) {
    const mailId = await getEmailId(email, token);
    if (mailId) {
      const code = await getVerificationCode(email, mailId, token);
      if (code) return { mailId, code };
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return { mailId: null, code: null };
}

export default async function handler(req, res) {
  try {
    // 允许跨域（如需限制可改为你的站点域名）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();

    const email = (req.query.email || "").toString().trim();
    if (!email) return res.status(400).json({ ok: false, error: "缺少 email 参数" });

    const token = await getAuthToken();
    const { mailId, code } = await pollLatestCode(email, token, 5, 3000);

    if (!mailId) return res.status(404).json({ ok: false, email, error: "未找到邮件ID（邮箱可能无新邮件）" });
    if (!code)   return res.status(404).json({ ok: false, email, mail_id: mailId, error: "未提取到验证码" });

    return res.status(200).json({ ok: true, email, mail_id: mailId, code });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "服务异常" });
  }
}
