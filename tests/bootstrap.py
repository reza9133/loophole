"""
Make the GenVM artifacts that genvm-lint downloads available to the direct test runner.

Both tools use the same GenVM release tarball but keep separate caches. Sharing it means the
offline tests work without a second download, and without needing the GitHub "latest release"
lookup the direct runner would otherwise perform.
"""

from __future__ import annotations

from pathlib import Path


def share_genvm_artifacts() -> None:
    linter = Path.home() / '.cache' / 'genvm-linter'
    direct = Path.home() / '.cache' / 'gltest-direct'
    if not linter.exists():
        return
    direct.mkdir(parents=True, exist_ok=True)
    if any(direct.glob('genvm-universal-*.tar.xz')):
        return
    for tarball in sorted(linter.glob('genvm-universal-*.tar.xz'), reverse=True):
        target = direct / tarball.name
        if not target.exists():
            try:
                target.symlink_to(tarball)
            except OSError:
                import shutil

                shutil.copy(tarball, target)
        return
