from __future__ import annotations

import logging
import pathlib
from dataclasses import dataclass, field

from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TALB, TIT2, TPE1
from mutagen.mp4 import MP4, MP4Cover
from mutagen.wave import WAVE


logger = logging.getLogger("qkkdecrypt.infrastructure.cover_art")


@dataclass(slots=True)
class CoverArtResult:
    status: str
    message: str
    image_path: str | None = None
    source: str | None = None


@dataclass(slots=True)
class AlbumMetadataResult:
    status: str
    message: str
    source: str | None = None
    updated_fields: tuple[str, ...] = field(default_factory=tuple)


def _detect_image_format(image_bytes: bytes) -> tuple[str | None, int | None]:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", MP4Cover.FORMAT_JPEG
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", MP4Cover.FORMAT_PNG
    return None, None


def _embed_mp3(audio_path: pathlib.Path, image_bytes: bytes, mime: str) -> bool:
    try:
        tags = ID3(str(audio_path))
    except ID3NoHeaderError:
        tags = ID3()
    tags.delall("APIC")
    tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=image_bytes))
    tags.save(str(audio_path), v2_version=3)
    return True


def _embed_m4a_cover(audio_path: pathlib.Path, image_bytes: bytes, picture_type: int | None) -> bool:
    if picture_type is None:
        return False
    audio = MP4(str(audio_path))
    if audio.tags is None:
        audio.add_tags()
    audio.tags["covr"] = [MP4Cover(image_bytes, imageformat=picture_type)]
    audio.save()
    return True


def _embed_flac(audio_path: pathlib.Path, image_bytes: bytes, mime: str) -> bool:
    audio = FLAC(str(audio_path))
    picture = Picture()
    picture.type = 3
    picture.mime = mime
    picture.desc = "Cover"
    picture.data = image_bytes
    audio.clear_pictures()
    audio.add_picture(picture)
    audio.save()
    return True


def _embed_cover(audio_path: pathlib.Path, image_path: pathlib.Path) -> bool:
    try:
        image_bytes = image_path.read_bytes()
        mime, picture_type = _detect_image_format(image_bytes)
        if not mime:
            return False
        suffix = audio_path.suffix.lower()
        if suffix == ".mp3":
            return _embed_mp3(audio_path, image_bytes, mime)
        if suffix == ".m4a":
            return _embed_m4a_cover(audio_path, image_bytes, picture_type)
        if suffix == ".flac":
            return _embed_flac(audio_path, image_bytes, mime)
        return False
    except Exception:
        logger.exception("Failed to embed cover art: %s", audio_path)
        return False


def _embed_album_metadata(
    *,
    audio_path: pathlib.Path,
    title: str,
    artist: str,
    album: str,
    current_title: str,
    current_artist: str,
    current_album: str,
) -> list[str]:
    suffix = audio_path.suffix.lower()
    updated_fields: list[str] = []
    requires_save = False
    if suffix == ".m4a":
        audio = MP4(str(audio_path))
        if audio.tags is None:
            audio.add_tags()
        if title and not current_title:
            audio.tags["\xa9nam"] = [title]
            updated_fields.append("title")
            requires_save = True
        if artist and not current_artist:
            audio.tags["\xa9ART"] = [artist]
            audio.tags["aART"] = [artist]
            updated_fields.append("artist")
            requires_save = True
        elif artist and not (audio.tags.get("aART") or []):
            audio.tags["aART"] = [artist]
            updated_fields.append("artist")
            requires_save = True
        if album and not current_album:
            audio.tags["\xa9alb"] = [album]
            updated_fields.append("album")
            requires_save = True
        if requires_save:
            audio.save()
        return updated_fields
    if suffix == ".wav":
        audio = WAVE(str(audio_path))
        if audio.tags is None:
            audio.add_tags()
        if title and not current_title:
            audio.tags.delall("TIT2")
            audio.tags.add(TIT2(encoding=3, text=[title]))
            updated_fields.append("title")
            requires_save = True
        if artist and not current_artist:
            audio.tags.delall("TPE1")
            audio.tags.add(TPE1(encoding=3, text=[artist]))
            updated_fields.append("artist")
            requires_save = True
        if album and not current_album:
            audio.tags.delall("TALB")
            audio.tags.add(TALB(encoding=3, text=[album]))
            updated_fields.append("album")
            requires_save = True
        if requires_save:
            audio.save()
        return updated_fields
    return updated_fields


def _embed_cover_art(audio_path: str | pathlib.Path, image_path: str | pathlib.Path) -> bool:
    """Standalone cover embedder used by transcoder.py."""
    return _embed_cover(pathlib.Path(audio_path), pathlib.Path(image_path))


__all__ = [
    "CoverArtResult",
    "AlbumMetadataResult",
    "_detect_image_format",
    "_embed_mp3",
    "_embed_m4a_cover",
    "_embed_flac",
    "_embed_cover",
    "_embed_album_metadata",
    "_embed_cover_art",
]
