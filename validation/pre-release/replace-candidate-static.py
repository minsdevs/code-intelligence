"""Replace only an owned candidate JAR's static assets; verify every other entry.

No extraction or source execution. The Java build and native signing remain separate.
"""
import hashlib
import json
import os
import pathlib
import stat
import sys
import zipfile


def validate_write_path(root: pathlib.Path, target: pathlib.Path) -> None:
    assert root.is_absolute() and root.resolve() == root
    assert target.is_absolute() and target == pathlib.Path(os.path.normpath(target))
    assert target != root and root in target.parents
    directories = [*reversed(root.parents), root]
    cursor = root
    for part in target.parent.relative_to(root).parts:
        cursor = cursor / part
        directories.append(cursor)
    for directory in directories:
        value = directory.lstat()
        assert stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode)
        assert directory.resolve() == directory
        if directory == root or root in directory.parents:
            assert value.st_uid == os.getuid() and value.st_mode & 0o7022 == 0
            if directory == root:
                assert stat.S_IMODE(value.st_mode) == 0o700
    assert not target.exists() and not target.is_symlink()


def main() -> None:
    source, destination, ui, classes, migrations, receipt, write_root = map(pathlib.Path, sys.argv[1:])
    validate_write_path(write_root, destination)
    validate_write_path(write_root, receipt)
    assert source.is_file() and not source.is_symlink() and not destination.exists()
    assert ui.is_dir() and classes.is_dir() and migrations.is_dir() and not receipt.exists()
    prefix = "BOOT-INF/classes/static/"
    assets = {prefix + str(p.relative_to(ui)).replace("\\", "/"): p.read_bytes()
              for p in ui.rglob("*") if p.is_file() and not p.is_symlink()}
    assert prefix + "index.html" in assets and len(assets) < 10000
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, "x") as changed:
        names = original.namelist()
        assert len(names) == len(set(names)) and len(names) < 100000
        assert all(not n.startswith("/") and ".." not in n.split("/") for n in names)
        preserved = []
        for info in original.infolist():
            assert info.file_size <= 512 * 1024 * 1024
            if info.filename.startswith(prefix):
                continue
            changed.writestr(info, original.read(info.filename))
            preserved.append(info.filename)
        for name, data in sorted(assets.items()):
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            changed.writestr(info, data)
    counts = {}
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination) as changed:
        assert set(changed.namelist()) == set(preserved) | set(assets)
        for name in preserved:
            assert changed.read(name) == original.read(name)
            assert changed.getinfo(name).compress_type == original.getinfo(name).compress_type
        for name, data in assets.items():
            assert changed.read(name) == data
        for label, root, archive_prefix in [
            ("compiledClassFiles", classes, "BOOT-INF/classes/"),
            ("migrationFiles", migrations, "BOOT-INF/classes/db/migration/"),
        ]:
            expected = {archive_prefix + str(p.relative_to(root)).replace("\\", "/"): p.read_bytes()
                        for p in root.rglob("*") if p.is_file() and not p.is_symlink()}
            assert expected
            for name, data in expected.items():
                assert changed.read(name) == data, name
            if label == "migrationFiles":
                assert {n for n in changed.namelist() if n.startswith(archive_prefix) and not n.endswith("/")} == set(expected)
            else:
                assert {n for n in changed.namelist() if n.startswith(archive_prefix) and n.endswith(".class")} == {n for n in expected if n.endswith(".class")}
            counts[label] = len(expected)
    encoded = json.dumps({
        "status": "PASS", "unchangedNonStaticEntries": len(preserved),
        "verifiedStaticEntries": len(assets), **counts,
        "originalJarSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "candidateJarSha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "nestedJarCompressionPreserved": True,
    }, indent=2) + "\n"
    with receipt.open("x") as output:
        output.write(encoded)


if __name__ == "__main__":
    main()
