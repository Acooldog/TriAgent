# Private Capability Repository

This repository contains private capability providers and their implementation details.

- Do not push this repository to the public TriMusicAgent remote.
- Keep provider source, runtime assets, native components, analysis material and provider-specific tests here.
- The public Agent repository may depend only on the versioned provider manifest, IPC/process protocol and redacted result contract.
- Before publishing any shared code, run the public boundary check in the public worktree.
- Ordinary Agent-core changes must be mirrored in both repositories, tested and reviewed separately before either branch is integrated.
- Provider-specific implementation changes may remain private-only.
