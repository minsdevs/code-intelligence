"""Synthetic file-only tests for the candidate static replacement boundary."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
import zipfile

MODULE = pathlib.Path(__file__).resolve().parents[1] / "replace-candidate-static.py"
spec = importlib.util.spec_from_file_location("candidate_static", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CandidateStaticTests(unittest.TestCase):
    def fixture(self, root, extra=False):
        ui, classes, migrations = (root / name for name in ["ui", "classes", "migrations"])
        for directory in [ui, classes, migrations]:
            directory.mkdir(mode=0o700)
        (ui / "index.html").write_text("new")
        (classes / "A.class").write_bytes(b"compiled-class")
        (migrations / "V1.sql").write_text("select 1;")
        source = root / "source.jar"
        with zipfile.ZipFile(source, "x") as jar:
            jar.writestr("BOOT-INF/classes/A.class", b"compiled-class")
            jar.writestr("BOOT-INF/classes/db/migration/V1.sql", "select 1;")
            jar.writestr("BOOT-INF/classes/static/old.js", "old")
            if extra:
                jar.writestr("BOOT-INF/classes/Stale.class", b"stale")
        return [source, root / "target.jar", ui, classes, migrations, root / "receipt.json", root]

    def run_main(self, arguments):
        previous = sys.argv
        try:
            sys.argv = [str(MODULE), *map(str, arguments)]
            module.main()
        finally:
            sys.argv = previous

    def test_replacement_exact_classes_and_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            args = self.fixture(root)
            self.run_main(args)
            receipt = json.loads(args[5].read_text())
            self.assertEqual(receipt["compiledClassFiles"], 1)
            with zipfile.ZipFile(args[1]) as jar:
                self.assertNotIn("BOOT-INF/classes/static/old.js", jar.namelist())
                self.assertEqual(jar.read("BOOT-INF/classes/static/index.html"), b"new")

    def test_extra_class_rejects_without_success_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.fixture(pathlib.Path(temporary).resolve(), extra=True)
            with self.assertRaises(AssertionError):
                self.run_main(args)
            self.assertFalse(args[5].exists())

    def test_symlink_write_parent_refused_before_target_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            preserved = root / "preserved"
            preserved.mkdir(mode=0o700)
            link = root / "link"
            link.symlink_to(preserved)
            with self.assertRaises(AssertionError):
                module.validate_write_path(root, link / "target.jar")
            self.assertEqual(list(preserved.iterdir()), [])

    def test_receipt_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.fixture(pathlib.Path(temporary).resolve())
            args[5].write_text("retained")
            with self.assertRaises(AssertionError):
                self.run_main(args)
            self.assertFalse(args[1].exists())
            self.assertEqual(args[5].read_text(), "retained")


if __name__ == "__main__":
    unittest.main()
