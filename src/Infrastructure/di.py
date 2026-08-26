"""Infrastructure.di — dependency injection wiring.

Builds the ``ApplicationPorts`` bundle from concrete Infrastructure adapters.
Presentation layer (CLI, Worker) and legacy Application callers use
``build_default_ports()`` when no explicit ports are provided.

This is the ONLY allowed cross-cutting point between Application and
Infrastructure.  Application modules must NOT import any adapter directly;
they depend exclusively on ``src.Domain.ports`` protocols.
"""
from __future__ import annotations

from src.Domain.ports import ApplicationPorts


def build_default_ports() -> ApplicationPorts:
    """Instantiate the standard Infrastructure adapter bundle.

    Discovery order matters: ``RuntimePaths.discover()`` must succeed before
    any adapter that needs file paths is constructed.
    """
    # Lazy imports keep this module free of startup side-effects and let
    # Application tests patch DI cleanly.
    from src.Infrastructure.adapters.media.cover.cover_art_service import CoverArtService
    from src.Infrastructure.adapters.media.transcode.transcoder import _TranscodeAdapter
    from src.Infrastructure.adapters.runtime.runtime_logging import _LoggingAdapter
    from src.Infrastructure.adapters.runtime.runtime_paths import RuntimePaths
    from src.Infrastructure.adapters.storage.output_manifest_repository import OutputManifestRepository

    paths = RuntimePaths.discover()
    paths.ensure_runtime_dirs()
    return ApplicationPorts(
        runtime=paths,
        cover_service=CoverArtService(),
        manifest_repo=OutputManifestRepository(paths.output_manifest),
        transcode=_TranscodeAdapter(),
        logging=_LoggingAdapter(),
    )


__all__ = ["build_default_ports"]
