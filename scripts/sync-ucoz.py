#!/usr/bin/env python3
"""Синхронізація новин зі старого сайту ліцею (kyshnica-soh.ucoz.ua) у news-archive.json.

Читає стрічку новин (RSS, 10 останніх), додає нові новини й оновлює змінені.
Фото зменшує до 800 px і зберігає в archive/news/. Токени не потрібні.

Запуск: python3 scripts/sync-ucoz.py
Потрібен Pillow (pip install pillow). Необов'язкові змінні:
  UCOZ_SITE    адреса старого сайту (https://kyshnica-soh.ucoz.ua)
  UCOZ_PHOTOS  скільки фото зберігати з однієї новини (3)
"""
import email.utils, html, io, json, os, re, sys, time, urllib.request
from zoneinfo import ZoneInfo
from pathlib import Path

SITE = os.environ.get("UCOZ_SITE", "https://kyshnica-soh.ucoz.ua").rstrip("/")
PHOTOS = max(0, int(os.environ.get("UCOZ_PHOTOS") or 3))
ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / "news-archive.json"
IMG_DIR = ROOT / "archive" / "news"
UA = {"User-Agent": "Mozilla/5.0 (compatible; lyceum-site-sync)"}


def get(url, timeout=40):
    for i in range(3):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()
        except Exception as e:  # noqa: BLE001
            if i == 2:
                raise
            print(f"Повтор після помилки: {url}: {e}", file=sys.stderr)
            time.sleep(3)


def clean(h):
    """HTML новини → простий текст з абзацами й пунктами списку."""
    h = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>|<!--.*?-->", "", h)
    h = re.sub(r"(?i)<li[^>]*>", "\n• ", h)
    h = re.sub(r"(?i)<br\s*/?>", "\n", h)
    h = re.sub(r"(?i)</(p|div|li|tr|h\d|ul|ol|table)>", "\n\n", h)
    h = html.unescape(re.sub(r"<[^>]+>", "", h)).replace("\xa0", " ")
    out = []
    for line in (re.sub(r"[ \t]+", " ", l).strip() for l in h.split("\n")):
        if not line:
            if out and out[-1]:
                out.append("")
        elif line != "•":
            out.append(line)
    t = re.sub(r"\n{3,}", "\n\n", "\n".join(out).strip())
    return re.sub(r"\n\n(• )", r"\n\1", t)


def video_links(h):
    out = []
    for href, t in re.findall(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', h, re.S):
        if re.search(r"facebook\.com|fb\.watch|youtu", href):
            t = re.sub(r"<[^>]+>|\s+", " ", html.unescape(t)).strip()
            if href not in [x["url"] for x in out]:
                out.append({"title": t, "url": href})
    return out


def photo_paths(h):
    out = []
    for src in re.findall(r'(?:src|href)="([^"]+\.(?:jpe?g|png|gif|webp))(?:\?[^"]*)?"', h, re.I):
        src = re.sub(r"^https?://[^/]*ucoz\.ua", "", src)
        if src.startswith("/") and "/.s/" not in src:
            full = re.sub(r"/_nw/(\d+)/s(\d+)", r"/_nw/\1/\2", src)  # мініатюра → повне фото
            if full not in out:
                out.append(full)
    return out


def save_photo(src, name):
    from PIL import Image, ImageOps
    path = IMG_DIR / name
    if path.exists():
        return True
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(get(SITE + src)))).convert("RGB")
        im.thumbnail((800, 800))
        im.save(path, "JPEG", quality=60, optimize=True, progressive=True)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"Не вдалося зберегти фото {src}: {e}", file=sys.stderr)
        return False


def page_body(link):
    """Повний текст новини зі сторінки: у стрічці RSS немає фото й посилань на відео."""
    try:
        s = get(link).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        print(f"Не вдалося відкрити {link}: {e}", file=sys.stderr)
        return ""
    m = re.search(r'class="eMessage"[^>]*>(.*?)</td>\s*</tr>', s, re.S)
    return m.group(1) if m else ""


def main():
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    data = json.loads(ARCHIVE.read_text(encoding="utf-8")) if ARCHIVE.exists() else {"posts": []}
    posts = {p["id"]: p for p in data.get("posts", [])}

    rss = get(f"{SITE}/news/rss/").decode("utf-8", "replace")
    items = re.findall(r"<item>(.*?)</item>", rss, re.S)
    if not items:
        raise SystemExit("У стрічці новин немає записів: перевірте адресу " + SITE + "/news/rss/")

    added = updated = 0
    remote = {}  # id → посилання на фото на старому сайті, для Viber (у репозиторій не зберігається)
    for it in items:
        def tag(name):
            m = re.search(rf"<{name}>(.*?)</{name}>", it, re.S)
            v = m.group(1).strip() if m else ""
            v = re.sub(r"^<!\[CDATA\[(.*)\]\]>$", r"\1", v, flags=re.S)
            return v
        link = html.unescape(tag("link"))
        m = re.search(r"/(\d{4}-\d\d-\d\d)-(\d+)/?$", link)
        if not m:
            continue
        pid = "old-" + m.group(2)
        rss_body = html.unescape(tag("description"))  # у стрічці HTML екранований
        title = html.unescape(re.sub(r"<[^>]+>", "", tag("title"))).strip()
        try:
            date = email.utils.parsedate_to_datetime(tag("pubDate")).astimezone(ZoneInfo("Europe/Kyiv")).isoformat(timespec="minutes")
        except Exception:  # noqa: BLE001
            date = m.group(1) + "T12:00+02:00"
        prev = posts.get(pid)
        # сторінку відкриваємо лише для нових новин або коли змінився текст у стрічці
        if prev and prev.get("title") == title and prev.get("rss") == clean(rss_body):
            continue
        body = page_body(link) or rss_body
        text = clean(body)
        if prev and prev.get("text") == text and prev.get("title") == title:
            prev["rss"] = clean(rss_body)
            continue
        images = list(prev.get("images", [])) if prev else []
        if not images and PHOTOS:
            for k, src in enumerate(photo_paths(body)[:PHOTOS]):
                name = f"{pid}-{k + 1}.jpg"
                if save_photo(src, name):
                    images.append(f"archive/news/{name}")
        srcs = photo_paths(body)
        if images and srcs:
            remote["old:" + pid] = SITE + srcs[0]
        posts[pid] = {"id": pid, "date": prev["date"] if prev else date, "title": title, "text": text,
                      "images": images, "links": video_links(body), "rss": clean(rss_body)}
        if prev:
            updated += 1
        else:
            added += 1

    data["posts"] = sorted(posts.values(), key=lambda p: p["date"], reverse=True)
    data["source"] = SITE.split("//")[-1]
    (ROOT / ".remote-images.json").write_text(json.dumps(remote), encoding="utf-8")
    ARCHIVE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Готово: нових новин {added}, змінених {updated}, усього {len(data['posts'])}.")


if __name__ == "__main__":
    main()
