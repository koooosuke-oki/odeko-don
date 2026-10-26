"""ダンサーモードのお題を暗号化して dancer.enc.json を作る。

お題の元ファイル（暗号化前）は公開しないよう、リポジトリの外に置く。
元ファイルの書き方：
    # 💃 ニュースタハロパ      ← 「# 絵文字 カテゴリ名」でカテゴリを始める
    ゆうた                   ← 1行に1つお題
    ...

使い方：
    DANCER_PASSWORD='パスワード' python3 tools/encrypt-words.py ../dancer-words.txt
"""
import base64
import json
import os
import sys
import unicodedata

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 200_000
OUT = os.path.join(os.path.dirname(__file__), '..', 'dancer.enc.json')


def parse(path):
    categories = []
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('#'):
            emoji, _, name = line[1:].strip().partition(' ')
            categories.append({'name': name.strip(), 'emoji': emoji, 'words': []})
        else:
            categories[-1]['words'].append(line)
    return categories


def main():
    password = os.environ.get('DANCER_PASSWORD')
    if not password or len(sys.argv) != 2:
        sys.exit(__doc__)
    # app.js の normalizePassword と同じ正規化
    password = unicodedata.normalize('NFKC', password).strip()

    categories = parse(sys.argv[1])
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(password.encode())
    data = AESGCM(key).encrypt(iv, json.dumps(categories, ensure_ascii=False).encode(), None)

    b64 = lambda b: base64.b64encode(b).decode()
    with open(OUT, 'w') as f:
        json.dump({'iterations': ITERATIONS, 'salt': b64(salt), 'iv': b64(iv), 'data': b64(data)}, f)
        f.write('\n')
    for c in categories:
        print(f"{c['emoji']} {c['name']}: {len(c['words'])}問")


if __name__ == '__main__':
    main()
