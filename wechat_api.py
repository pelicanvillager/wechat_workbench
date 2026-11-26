"""Create draft articles through the WeChat Official Accounts API."""
from http.client import HTTPException
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import build_opener, HTTPRedirectHandler, Request

API = 'https://api.weixin.qq.com/cgi-bin/'
ERROR_HINTS = {
    40001: '请核对 AppSecret 或接口调用凭据',
    40013: '请核对公众号 AppID',
    40125: '请核对公众号 AppSecret',
    40164: '请在公众号后台核对当前出口 IP 白名单',
    41001: '微信接口缺少调用凭据',
    45004: '请缩短摘要',
    48001: '当前公众号的接口权限不足',
}


class WeChatError(Exception):
    def __init__(self, message, rejected=False, *, public_ip=''):
        super().__init__(message)
        self.rejected = rejected
        self.public_ip = public_ip


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def normalize_public_ip(value):
    if '%' in value:
        return ''
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        return ''
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address) if address.is_global and not address.is_multicast else ''


def detect_public_ip():
    opener = build_opener(NoRedirect())
    for url in ('https://api64.ipify.org/', 'https://api.ipify.org/'):
        try:
            with opener.open(url, timeout=4) as response:
                public_ip = normalize_public_ip(response.read(128).decode('ascii'))
        except (OSError, ValueError, HTTPException):
            continue
        if public_ip:
            return public_ip
    return ''


CONFIG = Path.home() / '.config' / 'wechat-workbench' / 'wechat.json'


def valid_credentials(appid, secret):
    return (isinstance(appid, str) and isinstance(secret, str)
            and re.fullmatch(r'wx[0-9a-fA-F]{16}', appid) is not None
            and re.fullmatch(r'[A-Za-z0-9_-]+', secret) is not None)


def credentials():
    appid = os.environ.get('WECHAT_APPID')
    secret = os.environ.get('WECHAT_SECRET') or os.environ.get('WECHAT_APPSECRET')
    if appid or secret:
        return (appid, secret) if valid_credentials(appid, secret) else None
    if not CONFIG.is_file():
        return None
    data = json.loads(CONFIG.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        return None
    appid, secret = data.get('appid'), data.get('secret')
    return (appid, secret) if valid_credentials(appid, secret) else None


def request(endpoint, *, token='', params=None, payload=None, media=None):
    query = dict(params or {})
    if token:
        query['access_token'] = token
    url = API + endpoint + ('?' + urlencode(query) if query else '')
    headers = {'Accept': 'application/json'}
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json; charset=utf-8'
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    if media:
        name, mime, content = media
        boundary = secrets.token_hex(16)
        headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
        data = (f'--{boundary}\r\nContent-Disposition: form-data; name="media"; filename="{name}"\r\n'
                f'Content-Type: {mime}\r\n\r\n').encode() + content + f'\r\n--{boundary}--\r\n'.encode()
    try:
        with build_opener(NoRedirect()).open(Request(url, data=data, headers=headers), timeout=15) as response:
            result = json.loads(response.read(2_000_000))
    except (OSError, URLError, ValueError):
        raise WeChatError('微信接口连接失败或返回格式异常。') from None
    if not isinstance(result, dict):
        raise WeChatError('微信接口返回格式异常。')
    code = result.get('errcode')
    if code not in (None, 0):
        if isinstance(code, int):
            hint = ERROR_HINTS.get(code, '请在公众号后台核对接口权限和稿件素材')
            public_ip = ''
            if code == 40164 and isinstance(result.get('errmsg'), str):
                match = re.search(r'\binvalid ip\s+([0-9a-fA-F:.]+)(?=\s|,|$)', result['errmsg'], re.IGNORECASE)
                if match:
                    public_ip = normalize_public_ip(match[1])
            raise WeChatError(f'微信接口返回 {code}，{hint}。', rejected=True, public_ip=public_ip)
        raise WeChatError('微信接口返回格式异常。')
    return result


def check_access(appid, secret):
    data = request('stable_token', payload={'grant_type': 'client_credential', 'appid': appid,
                                           'secret': secret, 'force_refresh': False})
    token = data.get('access_token')
    if not isinstance(token, str) or not token:
        raise WeChatError('微信未返回有效的接口调用凭据。')
    if not isinstance(request('draft/count', token=token).get('total_count'), int):
        raise WeChatError('微信未返回草稿箱权限确认。')
    return token


def prepare_image(source, scratch, limit):
    data = source.read_bytes()
    image_type = 'png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'jpeg' if data.startswith(b'\xff\xd8\xff') else ''
    if image_type and len(data) <= limit:
        return ('image.png' if image_type == 'png' else 'image.jpg', 'image/' + image_type, data)
    output = scratch / 'image.jpg'
    for width in (1600, 1100, 800):
        output.unlink(missing_ok=True)
        run = subprocess.run(['/usr/bin/sips', '-Z', str(width), '-s', 'format', 'jpeg',
                              '-s', 'formatOptions', '65', str(source), '--out', str(output)],
                             capture_output=True, timeout=20)
        if run.returncode == 0 and output.is_file():
            data = output.read_bytes()
            if data.startswith(b'\xff\xd8\xff') and len(data) <= limit:
                return 'image.jpg', 'image/jpeg', data
    raise WeChatError(f'图片无法转换到微信接口所需大小：{source.name}。')
