"""Exercise validation on independent manifests/archives, not script source text."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'verify-release.py'

class ReleaseVerificationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('release', SCRIPT)
        self.release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.release)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def manifests(self, js='0.1.0', lock='0.1.0', python='0.1.0'):
        j = self.root / 'packages/aix-js'
        p = self.root / 'packages/aix-python'
        j.mkdir(parents=True, exist_ok=True)
        p.mkdir(parents=True, exist_ok=True)
        (j / 'package.json').write_text(json.dumps({'name': '@brambles-ai/aix', 'version': js}))
        (j / 'package-lock.json').write_text(json.dumps({'name': '@brambles-ai/aix', 'version': lock, 'packages': {'': {'name': '@brambles-ai/aix', 'version': lock}}}))
        (p / 'pyproject.toml').write_text(f'[project]\nname="brambles-aix"\nversion="{python}"\n')

    def test_aligned_exact_version_is_required(self):
        self.manifests()
        self.release.check_versions(self.root, '0.1.0')
        for version in ['0.2.0', 'v0.1.0', '0.1', '0.1.0;publish']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.release.check_versions(self.root, version)

    def test_lock_and_python_drift_block_release(self):
        for js, lock, py in [('0.1.1', '0.1.0', '0.1.0'), ('0.1.0', '0.1.1', '0.1.0'), ('0.1.0', '0.1.0', '0.1.1')]:
            self.manifests(js, lock, py)
            with self.subTest(js=js, lock=lock, py=py), self.assertRaises(ValueError):
                self.release.check_versions(self.root, '0.1.0')

    def npm_archive(self, missing=None, extra=None, version='0.1.0'):
        package = {'name': '@brambles-ai/aix', 'version': version, 'main': './dist/index.js', 'types': './dist/index.d.ts', 'exports': {'.': {'import': './dist/index.js', 'types': './dist/index.d.ts'}}}
        files = {'package/package.json': json.dumps(package), 'package/README.md': 'docs', 'package/LICENSE': 'terms', 'package/dist/index.js': 'export {}', 'package/dist/index.d.ts': 'export {}'}
        if missing: files.pop(missing)
        if extra: files[extra] = 'private'
        path = self.root / 'aix.tgz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, text in files.items():
                data = text.encode()
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return path

    def test_npm_archive_needs_imports_types_license_and_exact_metadata(self):
        self.release.check_npm(self.npm_archive(), '0.1.0')
        for kwargs in [{'missing': 'package/dist/index.d.ts'}, {'missing': 'package/LICENSE'}, {'version': '0.2.0'}, {'extra': 'package/.env'}, {'extra': 'package/dist/../../secret'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.release.check_npm(self.npm_archive(**kwargs), '0.1.0')

    def wheel(self, missing=None, version='0.1.0'):
        files = {'brambles_aix/__init__.py': '', 'brambles_aix/client.py': '', 'brambles_aix/py.typed': '', 'brambles_aix/adapters/openai_agents.py': '', 'brambles_aix/adapters/langchain.py': '', 'brambles_aix-0.1.0.dist-info/METADATA': f'Name: brambles-aix\nVersion: {version}\n', 'brambles_aix-0.1.0.dist-info/licenses/LICENSE': 'terms'}
        if missing: files.pop(missing)
        path = self.root / 'aix.whl'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, text in files.items(): archive.writestr(name, text)
        return path

    def test_wheel_needs_typed_package_adapters_license_and_exact_metadata(self):
        self.release.check_wheel(self.wheel(), '0.1.0')
        for kwargs in [{'missing': 'brambles_aix/py.typed'}, {'missing': 'brambles_aix/adapters/langchain.py'}, {'missing': 'brambles_aix-0.1.0.dist-info/licenses/LICENSE'}, {'version': '0.2.0'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.release.check_wheel(self.wheel(**kwargs), '0.1.0')

    def test_sdist_allows_builder_gitignore_but_rejects_secrets_and_wrong_metadata(self):
        def make(version='0.1.0', extra=None):
            prefix = 'brambles_aix-0.1.0/'
            files = {name: '' for name in ['pyproject.toml', 'README.md', 'LICENSE', 'src/brambles_aix/__init__.py', 'src/brambles_aix/py.typed', '.gitignore']}
            files['PKG-INFO'] = f'Name: brambles-aix\nVersion: {version}\n'
            if extra: files[extra] = 'secret'
            path = self.root / 'aix.tar.gz'
            with tarfile.open(path, 'w:gz') as archive:
                for name, text in files.items():
                    data = text.encode()
                    member = tarfile.TarInfo(prefix + name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            return path
        self.release.check_sdist(make(), '0.1.0')
        for kwargs in [{'extra': '.env'}, {'extra': 'src/brambles_aix/.env'}, {'version': '0.2.0'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.release.check_sdist(make(**kwargs), '0.1.0')

    def test_tag_requires_exact_version_clean_tree_and_current_commit(self):
        import subprocess
        def git(*args): return subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True)
        git('init', '-b', 'main')
        git('config', 'user.email', 'fixture@example.invalid')
        git('config', 'user.name', 'Fixture')
        (self.root / 'file').write_text('initial')
        git('add', 'file')
        git('commit', '-m', 'fixture')
        git('tag', 'v0.1.0')
        self.release.check_tag(self.root, '0.1.0', 'v0.1.0')
        with self.assertRaises(ValueError): self.release.check_tag(self.root, '0.1.0', 'v0.2.0')
        (self.root / 'file').write_text('changed')
        with self.assertRaises(ValueError): self.release.check_tag(self.root, '0.1.0', 'v0.1.0')
        git('add', 'file')
        git('commit', '-m', 'changed')
        with self.assertRaises(ValueError): self.release.check_tag(self.root, '0.1.0', 'v0.1.0')

if __name__ == '__main__': unittest.main()
