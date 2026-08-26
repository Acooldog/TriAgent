from __future__ import annotations
import logging
import pathlib
import re
from typing import Any
from src.Infrastructure.cover_art_search import (
    COVER_URL_TEMPLATE,
    search_cover_online,
    download_cover_image,
    _cache_key,
)
from src.Infrastructure.cover_embedder import (
    AlbumMetadataResult,
    CoverArtResult,
    _detect_image_format,
    _embed_album_metadata as _embed_album_metadata_impl,
    _embed_cover as _embed_cover_impl,
)
from src.Infrastructure.runtime_paths import RuntimePaths

try:
    from mutagen.mp4 import MP4
    from mutagen.wave import WAVE
except Exception:
    MP4 = None
    WAVE = None

logger = logging.getLogger("qkkdecrypt.infrastructure.cover_art")

class CoverArtService:
    """Supplement cover art and album metadata with a local-first strategy."""

    IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
    SUPPORTED_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".flac"}
    ALBUM_METADATA_EXTENSIONS = {".m4a", ".wav"}

    def __init__(self) -> None:
        self.paths = RuntimePaths.discover()
        self.cache_dir = self.paths.plugins_dir / "cover_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._search_cache: dict[str, dict[str, str] | None] = {}
        self._download_cache: dict[str, pathlib.Path | None] = {}

    def supplement_cover(
        self,
        audio_path: str | pathlib.Path,
        source_file_path: str | pathlib.Path,
        media_summary: dict[str, Any] | None = None,
    ) -> CoverArtResult:
        audio = pathlib.Path(audio_path)
        source = pathlib.Path(source_file_path)
        audio_ext = audio.suffix.lower()
        if audio_ext not in self.SUPPORTED_AUDIO_EXTENSIONS:
            return CoverArtResult(status="unsupported", message=f"cover embedding is not supported for {audio_ext or 'unknown'}")
        if media_summary and bool(media_summary.get("has_cover") or media_summary.get("cover")):
            return CoverArtResult(status="already_present", message="cover art already present")
        title, artist, album = self._extract_music_identity(audio, source, media_summary or {})
        if not title and not artist:
            return CoverArtResult(status="missing_metadata", message="no usable title/artist for cover lookup")
        local_image = self._find_local_cover(source, audio, title, artist, album)
        if local_image:
            if self._embed_cover(audio, local_image):
                return CoverArtResult("embedded", "embedded cover from local file", str(local_image), "local")
            return CoverArtResult("embed_failed", "failed to embed local cover", str(local_image), "local")
        cache_key = _cache_key(title, artist, album)
        cached_image = self._find_cached_cover(cache_key)
        if cached_image:
            if self._embed_cover(audio, cached_image):
                return CoverArtResult("embedded", "embedded cover from cache", str(cached_image), "cache")
            return CoverArtResult("embed_failed", "failed to embed cached cover", str(cached_image), "cache")
        search_result = search_cover_online(title, artist, self._search_cache)
        if not search_result:
            return CoverArtResult("not_found", "cover art was not found locally or online")
        downloaded = download_cover_image(search_result["albummid"], cache_key, self.cache_dir, self._download_cache)
        if not downloaded:
            return CoverArtResult("download_failed", "failed to download cover art")
        if self._embed_cover(audio, downloaded):
            return CoverArtResult("embedded", "embedded cover from QQ network fallback", str(downloaded), "network")
        return CoverArtResult("embed_failed", "failed to embed downloaded cover", str(downloaded), "network")

    def supplement_album_metadata(
        self,
        audio_path: str | pathlib.Path,
        source_file_path: str | pathlib.Path,
        media_summary: dict[str, Any] | None = None,
    ) -> AlbumMetadataResult:
        audio = pathlib.Path(audio_path)
        source = pathlib.Path(source_file_path)
        audio_ext = audio.suffix.lower()
        if audio_ext not in self.ALBUM_METADATA_EXTENSIONS:
            return AlbumMetadataResult(status="unsupported", message=f"album metadata supplementation is not supported for {audio_ext or 'unknown'}")
        fallback_title, fallback_artist, _ = self._extract_music_identity(audio, source, media_summary or {})
        embedded_title, embedded_artist, embedded_album = self._extract_embedded_audio_tags(audio, media_summary or {})
        if embedded_title and embedded_artist and embedded_album:
            return AlbumMetadataResult(status="already_present", message="album metadata already present", source="local")
        search_result = search_cover_online(fallback_title or embedded_title, fallback_artist or embedded_artist, self._search_cache)
        if not search_result:
            return AlbumMetadataResult(status="not_found", message="album metadata was not found locally or online")
        target_title = embedded_title or fallback_title or str(search_result.get("title") or "").strip()
        target_artist = embedded_artist or fallback_artist or str(search_result.get("artist") or "").strip()
        target_album = embedded_album or str(search_result.get("album") or "").strip()
        updated_fields = _embed_album_metadata_impl(
            audio_path=audio, title=target_title, artist=target_artist, album=target_album,
            current_title=embedded_title, current_artist=embedded_artist, current_album=embedded_album,
        )
        if updated_fields:
            return AlbumMetadataResult(
                status="embedded", message="album metadata supplemented",
                source="network" if not embedded_album else "local", updated_fields=tuple(updated_fields),
            )
        return AlbumMetadataResult(status="already_present", message="album metadata already present", source="local")

    def _extract_music_identity(
        self, audio_path: pathlib.Path, source_file_path: pathlib.Path, media_summary: dict[str, Any],
    ) -> tuple[str, str, str]:
        tags = media_summary.get("tags") if isinstance(media_summary.get("tags"), dict) else {}
        if not tags and isinstance(media_summary.get("metadata"), dict):
            tags = media_summary.get("metadata") or {}
        title = self._first_non_empty(tags.get("title"), tags.get("TITLE"))
        artist = self._first_non_empty(tags.get("artist"), tags.get("ARTIST"), tags.get("album_artist"))
        album = self._first_non_empty(tags.get("album"), tags.get("ALBUM"))
        if title or artist:
            return str(title or "").strip(), str(artist or "").strip(), str(album or "").strip()
        stem = source_file_path.stem if source_file_path else audio_path.stem
        stem = re.sub(r"_([A-Za-z0-9]{1,6})$", "", stem)
        if " - " in stem:
            artist_part, title_part = stem.split(" - ", 1)
            return title_part.strip(), artist_part.strip(), ""
        return stem.strip(), "", ""

    def _extract_embedded_audio_tags(self, audio_path: pathlib.Path, media_summary: dict[str, Any]) -> tuple[str, str, str]:
        tags = media_summary.get("tags") if isinstance(media_summary.get("tags"), dict) else {}
        if not tags and isinstance(media_summary.get("metadata"), dict):
            tags = media_summary.get("metadata") or {}
        title = self._first_non_empty(tags.get("title"), tags.get("TITLE"))
        artist = self._first_non_empty(tags.get("artist"), tags.get("ARTIST"), tags.get("album_artist"))
        album = self._first_non_empty(tags.get("album"), tags.get("ALBUM"))
        if title or artist or album:
            return str(title or "").strip(), str(artist or "").strip(), str(album or "").strip()
        try:
            suffix = audio_path.suffix.lower()
            if suffix == ".m4a" and MP4 is not None:
                audio = MP4(str(audio_path))
                tags = audio.tags or {}
                return (
                    self._first_non_empty(*(tags.get("\xa9nam") or [])),
                    self._first_non_empty(*(tags.get("\xa9ART") or []), *(tags.get("aART") or [])),
                    self._first_non_empty(*(tags.get("\xa9alb") or [])),
                )
            if suffix == ".wav" and WAVE is not None:
                audio = WAVE(str(audio_path))
                tags = audio.tags
                if tags is None:
                    return "", "", ""
                title_frame = tags.getall("TIT2")
                artist_frame = tags.getall("TPE1")
                album_frame = tags.getall("TALB")
                return (
                    self._first_non_empty(*[str(text) for frame in title_frame for text in getattr(frame, "text", [])]),
                    self._first_non_empty(*[str(text) for frame in artist_frame for text in getattr(frame, "text", [])]),
                    self._first_non_empty(*[str(text) for frame in album_frame for text in getattr(frame, "text", [])]),
                )
        except Exception:
            logger.exception("Failed to read embedded album tags: %s", audio_path)
        return "", "", ""

    @staticmethod
    def _first_non_empty(*values: object) -> str:
        for value in values:
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    def _find_local_cover(
        self, source_file_path: pathlib.Path, audio_path: pathlib.Path,
        title: str, artist: str, album: str,
    ) -> pathlib.Path | None:
        candidates: list[pathlib.Path] = []
        for ext in self.IMAGE_EXTENSIONS:
            candidates.append(source_file_path.with_suffix(ext))
            candidates.append(audio_path.with_suffix(ext))
        for folder in {source_file_path.parent, audio_path.parent}:
            for common_name in ("cover", "folder", "album", "front"):
                for ext in self.IMAGE_EXTENSIONS:
                    candidates.append(folder / f"{common_name}{ext}")
            for basis in filter(None, {title, album, f"{artist} - {title}" if artist and title else ""}):
                safe = self._sanitize_file_name(basis)
                for ext in self.IMAGE_EXTENSIONS:
                    candidates.append(folder / f"{safe}{ext}")
        for candidate in candidates:
            if candidate.exists() and candidate.is_file():
                return candidate
        cache_key = _cache_key(title, artist, album)
        return self._find_cached_cover(cache_key)

    @staticmethod
    def _sanitize_file_name(value: str) -> str:
        sanitized = re.sub(r'[<>:"/\\\\|?*]', "_", value.strip())
        return re.sub(r"\s+", " ", sanitized)

    def _find_cached_cover(self, cache_key: str) -> pathlib.Path | None:
        cached = self._download_cache.get(cache_key)
        if cached is not None and cached.exists():
            return cached
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            candidate = self.cache_dir / f"{cache_key}{ext}"
            if candidate.exists() and candidate.is_file():
                self._download_cache[cache_key] = candidate
                return candidate
        return None

    def _embed_cover(self, audio_path: pathlib.Path, image_path: pathlib.Path) -> bool:
        return _embed_cover_impl(audio_path, image_path)

__all__ = [
    "CoverArtService",
    "CoverArtResult",
    "AlbumMetadataResult",
]
