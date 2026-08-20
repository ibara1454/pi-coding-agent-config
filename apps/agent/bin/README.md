# Managed binaries

This directory is used by Pi for locally managed helper binaries, including
`fd` and `rg` (ripgrep). Pi downloads compatible platform-specific releases
here when they are not already available on the system `PATH`.

The binaries are intentionally ignored because they are generated, platform-
specific, and should not be committed to the repository.
