# api/index.py
import re
import time
from urllib.parse import quote

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # 如需限制来源，可改为 CORS(app, resources={r"/api/*": {"origins": "https://your.site"}})

MAIL_CX_BASE = "https://api.mail.cx/api/v1"
CODE_PATTERN = r'(?<!\d)(\d{4,8})(?!\d)'

# —— 简单的内存级 token 缓存（函数式，无外部依赖；Serverless 环境下不保证长期有效，但可减少同一次冷启动内请求）——
_token_cache = {"token": None, "ts": 0, "ttl": 60}  # 60秒简单缓存

def get_auth_token():
    now = time.time()
    if _token_cache["token"] and now - _token_cache["ts"] < _token_cache["ttl"]:
        return _token_cache["token"]

    url = f"{MAIL_CX_BASE}/auth/authorize_token"
    try:
        resp = requests.post(url, headers={"accept": "application/json"}, timeout=15)
        resp.raise_for_status()
        token = resp.text.strip().strip('"')
        if token:
            _token_cache.update({"token": token, "ts": now})
        return token
    except Exception as e:
        app.logger.error(f"Token 获取失败: {e}")
        return None


def get_email_id(email):
    encoded_email = quote(email)
    url = f"{MAIL_CX_BASE}/mailbox/{encoded_email}"
    try:
        token = get_auth_token()
        if not token:
            raise RuntimeError("无法获取授权 Token")
        resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        resp.raise_for_status()
        mails = resp.json()
        return mails[0]["id"] if mails else None
    except Exception as e:
        app.logger.error(f"邮件ID获取失败: {e}")
        return None


def get_verification_code(email, mail_id):
    encoded_email = quote(email)
    url = f"{MAIL_CX_BASE}/mailbox/{encoded_email}/{mail_id}"
    try:
        token = get_auth_token()
        if not token:
            raise RuntimeError("无法获取授权 Token")
        resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        resp.raise_for_status()
        mail = resp.json()

        text = (mail.get("body", {}) or {}).get("text", "") or ""
        html = (mail.get("body", {}) or {}).get("html", "") or ""

        match = re.search(CODE_PATTERN, text)
        if not match:
            match = re.search(CODE_PATTERN, html)
        return match.group(1) if match else None
    except Exception as e:
        app.logger.error(f"验证码提取失败: {e}")
        return None


# ---------------------- API 路由 ----------------------

@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({"ok": True, "message": "pong"})

@app.route("/api/token", methods=["GET"])
def api_token():
    token = get_auth_token()
    if not token:
        return jsonify({"ok": False, "error": "Token 获取失败"}), 500
    return jsonify({"ok": True, "token": token})

@app.route("/api/email-id", methods=["GET"])
def api_email_id():
    email = request.args.get("email", "").strip()
    if not email:
        return jsonify({"ok": False, "error": "缺少 email 参数"}), 400
    mail_id = get_email_id(email)
    if not mail_id:
        return jsonify({"ok": False, "error": "未找到邮件ID"}), 404
    return jsonify({"ok": True, "email": email, "mail_id": mail_id})

@app.route("/api/code", methods=["GET"])
def api_code():
    """
    用法：
    1) 直接给 email：/api/code?email=foo@bar.com
       - 自动取该邮箱的最新邮件ID，再解析验证码
    2) 指定 email + mail_id：/api/code?email=foo@bar.com&mail_id=12345
       - 跳过列表查询，直接解析指定邮件
    """
    email = request.args.get("email", "").strip()
    if not email:
        return jsonify({"ok": False, "error": "缺少 email 参数"}), 400

    mail_id = request.args.get("mail_id", "").strip()
    if not mail_id:
        mail_id = get_email_id(email)
        if not mail_id:
            return jsonify({"ok": False, "error": "未找到邮件ID"}), 404

    code = get_verification_code(email, mail_id)
    if not code:
        # 你也可以在这里增加重试/等待逻辑
        return jsonify({"ok": False, "email": email, "mail_id": mail_id, "error": "未提取到验证码"}), 404

    return jsonify({"ok": True, "email": email, "mail_id": mail_id, "code": code})


# 入口（Vercel 会自动识别 Flask 的 app 对象）
# 本地调试：python api/index.py
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=4321, debug=True)
