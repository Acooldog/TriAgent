from __future__ import annotations
import hashlib
import json
import logging
import pathlib
import re
import urllib.request
from typing import Any

logger = logging.getLogger("qkkdecrypt.infrastructure.cover_search")

SEARCH_ENDPOINT = "https://u.y.qq.com/cgi-bin/musicu.fcg"
COVER_URL_TEMPLATE = "https://y.gtimg.cn/music/photo_new/T002R500x500M000{albummid}.jpg"

def _cache_key(title: str, artist: str, album: str) -> str:
    basis = "|".join([title.strip().lower(), artist.strip().lower(), album.strip().lower()])
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()

def _normalize_compare_text(value: str) -> str:
    lowered = value.lower().strip()
    lowered = re.sub(r"\(.*?\)", "", lowered)
    lowered = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", lowered)
    return lowered

def _score_search_item(item: dict[str, Any], title: str, artist: str) -> int:
    item_title = _normalize_compare_text(str(item.get("name") or ""))
    item_artists = [
        _normalize_compare_text(str(singer.get("name") or ""))
        for singer in (item.get("singer") or [])
        if isinstance(singer, dict)
    ]
    title_norm = _normalize_compare_text(title)
    artist_norm = _normalize_compare_text(artist)
    score = 0
    if title_norm and item_title == title_norm:
        score += 4
    elif title_norm and title_norm in item_title:
        score += 2
    if artist_norm and any(artist_norm == singer or artist_norm in singer for singer in item_artists):
        score += 3
    return score

def search_cover_online(
    title: str, artist: str,
    search_cache: dict[str, dict[str, str] | None],
) -> dict[str, str] | None:
    query = " ".join(part for part in (title, artist) if part).strip()
    if not query:
        return None
    query_key = _cache_key(title, artist, "")
    if query_key in search_cache:
        return search_cache[query_key]
    payload = {
        "comm": {"ct": "19", "cv": "1859", "uin": "0"},
        "req": {
            "method": "DoSearchForQQMusicDesktop",
            "module": "music.search.SearchCgiService",
            "param": {"grp": 1, "num_per_page": 10, "page_num": 1, "query": query, "search_type": 0},
        },
    }
    request = urllib.request.Request(
        SEARCH_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json;charset=utf-8", "User-Agent": "Mozilla/5.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.load(response)
    except Exception:
        logger.exception("QQ cover search failed for query=%s", query)
        search_cache[query_key] = None
        return None
    song_list = (((data.get("req") or {}).get("data") or {}).get("body") or {}).get("song") or {}
    items = song_list.get("list") or []
    best: dict[str, Any] | None = None
    best_score = -1
    for item in items:
        score = _score_search_item(item, title, artist)
        if score > best_score:
            best = item
            best_score = score
    if not best or best_score < 2:
        search_cache[query_key] = None
        return None
    album = best.get("album") or {}
    albummid = album.get("mid")
    if not albummid:
        search_cache[query_key] = None
        return None
    singers = best.get("singer") or []
    singer_names = " / ".join(
        str(singer.get("name") or "").strip()
        for singer in singers
        if isinstance(singer, dict) and str(singer.get("name") or "").strip()
    )
    result = {
        "albummid": str(albummid),
        "album": str(album.get("name") or "").strip(),
        "title": str(best.get("name") or "").strip(),
        "artist": singer_names,
    }
    search_cache[query_key] = result
    return result

def download_cover_image(
    albummid: str, cache_key: str, cache_dir: pathlib.Path,
    download_cache: dict[str, pathlib.Path | None],
) -> pathlib.Path | None:
    cached = download_cache.get(cache_key)
    if cached is not None and cached.exists():
        return cached
    url = COVER_URL_TEMPLATE.format(albummid=albummid)
    cache_path = cache_dir / f"{cache_key}.jpg"
    try:
        with urllib.request.urlopen(url, timeout=12) as response:
            data = response.read()
        if not data:
            download_cache[cache_key] = None
            return None
        cache_path.write_bytes(data)
        download_cache[cache_key] = cache_path
        return cache_path
    except Exception:
        logger.exception("Failed to download cover art: %s", url)
        download_cache[cache_key] = None
        return None

__all__ = [
    "SEARCH_ENDPOINT",
    "COVER_URL_TEMPLATE",
    "search_cover_online",
    "download_cover_image",
    "_cache_key",
]
