#!/usr/bin/env python3
"""Build and inspect local release artifacts. Never publish, tag, or issue credentials.

Requires Python 3.11+, Node, npm, and installed package test/build dependencies.
"""
import argparse
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_versions(root, version):
    require(re.fullmatch(r'0|[1-9]\d*', version.split('.')[0]) is not None and re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version), 'version must be an exact stable X.Y.Z version')
    js = json.loads((root / 'packages/aix-js/package.json').read_text())
    lock = json.loads((root / 'packages/aix-js/package-lock.json').read_text())
    py = tomllib.loads((root / 'packages/aix-python/pyproject.toml').read_text())['project']
    require(js['name'] == '@brambles-ai/aix' and py['name'] == 'brambles-aix', 'package names changed')
    require(lock['name'] == js['name'] and lock['packages']['']['name'] == js['name'], 'lockfile package name drift')
    require(all(value == version for value in [js['version'], lock['version'], lock['packages']['']['version'], py['version']]), 'package/lockfile/Python versions must match requested version')


def check_tag(root, version, tag):
    require(tag == f'v{version}', 'tag must be v plus the exact package version')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
    require(not git('status', '--porcelain'), 'tag verification requires a clean working tree')
    require(git('rev-parse', f'refs/tags/{tag}^{{commit}}') == git('rev-parse', 'HEAD'), 'tag does not identify the current commit')


def safe_names(names):
    for name in names:
        path = PurePosixPath(name)
        require(not path.is_absolute() and '..' not in path.parts and '\\' not in name, 'unsafe archive path')
        require(not any(part.startswith('.') and not part.endswith('.dist-info') for part in path.parts), 'hidden file in release archive')


def check_npm(path, version):
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        names = {m.name for m in members if m.isfile()}
        safe_names(m.name for m in members)
        require(all(not m.issym() and not m.islnk() for m in members), 'links in npm archive')
        require({'package/package.json', 'package/README.md', 'package/LICENSE'} <= names, 'npm metadata/docs/license missing')
        require(all(name in {'package/package.json', 'package/README.md', 'package/LICENSE'} or name.startswith('package/dist/') for name in names), 'unexpected file in npm archive')
        package = json.load(archive.extractfile('package/package.json'))
        require(package['name'] == '@brambles-ai/aix' and package['version'] == version, 'npm archive version/name mismatch')
        targets = [package['main'], package['types']]
        for export in package['exports'].values():
            require(isinstance(export, dict) and 'import' in export and 'types' in export, 'npm exports need import and types')
            targets.extend([export['import'], export['types']])
        require(all('package/' + target.removeprefix('./') in names for target in targets), 'npm export or type declaration missing')


def check_wheel(path, version):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        safe_names(names)
        required = {'brambles_aix/__init__.py', 'brambles_aix/client.py', 'brambles_aix/py.typed', 'brambles_aix/adapters/openai_agents.py', 'brambles_aix/adapters/langchain.py'}
        require(required <= names, 'Python package, adapters or typing marker missing')
        metadata = [name for name in names if name.endswith('.dist-info/METADATA')]
        require(len(metadata) == 1, 'wheel metadata missing or ambiguous')
        info = BytesParser().parsebytes(archive.read(metadata[0]))
        require(info['Name'] == 'brambles-aix' and info['Version'] == version, 'wheel version/name mismatch')
        require(any(name.endswith('/LICENSE') and '.dist-info/' in name for name in names), 'wheel license missing')
        require(all(name.startswith('brambles_aix/') or name.startswith(f'brambles_aix-{version}.dist-info/') for name in names), 'unexpected file in wheel')


def check_sdist(path, version):
    prefix = f'brambles_aix-{version}/'
    with tarfile.open(path) as archive:
        names = {m.name for m in archive.getmembers() if m.isfile()}
        safe_names(name for name in names if name != prefix + '.gitignore')
        require(all(not m.issym() and not m.islnk() for m in archive.getmembers()), 'links in sdist')
        require(all(name.startswith(prefix) for name in names), 'unexpected sdist root')
        require({prefix + value for value in ['PKG-INFO', 'pyproject.toml', 'README.md', 'LICENSE', 'src/brambles_aix/__init__.py', 'src/brambles_aix/py.typed']} <= names, 'sdist metadata/package contents missing')
        info = BytesParser().parsebytes(archive.extractfile(prefix + 'PKG-INFO').read())
        require(info['Name'] == 'brambles-aix' and info['Version'] == version, 'sdist version/name mismatch')


def run(*command, cwd=ROOT, capture=False):
    print('+ ' + ' '.join(map(str, command)), flush=True)
    return subprocess.run(list(map(str, command)), cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--tag', help='additionally require exact vX.Y.Z tag at clean HEAD')
    parser.add_argument('--output', type=Path, help='new/empty artifact directory; default .artifacts/VERSION')
    args = parser.parse_args()
    check_versions(ROOT, args.version)
    if args.tag:
        check_tag(ROOT, args.version, args.tag)
    output = (args.output or ROOT / '.artifacts' / args.version).resolve()
    require(not output.exists() or (output.is_dir() and not any(output.iterdir())), 'artifact output must be new or empty; existing artifacts are never overwritten')

    run('node', '--test', 'test/connection-probe.test.mjs')
    run(sys.executable, '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py')
    run('npm', 'test', cwd=ROOT / 'packages/aix-js')
    run('npm', 'run', 'typecheck', cwd=ROOT / 'packages/aix-js')
    run(sys.executable, '-m', 'pytest', 'packages/aix-python')
    run('npm', 'run', 'clean', cwd=ROOT / 'packages/aix-js')
    run('npm', 'run', 'build', cwd=ROOT / 'packages/aix-js')
    with tempfile.TemporaryDirectory(prefix='aix-release-') as temporary:
        stage = Path(temporary)
        artifacts = stage / 'artifacts'
        artifacts.mkdir()
        run('npm', 'pack', '--ignore-scripts', '--pack-destination', artifacts, cwd=ROOT / 'packages/aix-js')
        # The default build builds the wheel FROM the sdist, checking both distributions.
        run(sys.executable, '-m', 'build', '--outdir', artifacts, 'packages/aix-python')
        npm, = artifacts.glob('*.tgz')
        wheel, = artifacts.glob('*.whl')
        sdist, = artifacts.glob('*.tar.gz')
        check_npm(npm, args.version)
        check_wheel(wheel, args.version)
        check_sdist(sdist, args.version)
        run(sys.executable, '-m', 'twine', 'check', '--strict', wheel, sdist)
        smoke_js = stage / 'js'
        smoke_js.mkdir()
        run('npm', 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefix', smoke_js, npm)
        run('node', '--input-type=module', '-e', "import {createAixClient} from '@brambles-ai/aix'; const r=await createAixClient({key:undefined}).sendIntent({}); if(r.reason!=='no_key') process.exit(1);", cwd=smoke_js)
        smoke_py = stage / 'python'
        run(sys.executable, '-m', 'pip', 'install', '--no-deps', '--target', smoke_py, wheel)
        # Fresh interpreter outside the checkout, installed wheel first on sys.path.
        run(sys.executable, '-c', f"import sys; sys.path.insert(0, {str(smoke_py)!r}); from brambles_aix import AixClient; from importlib.metadata import version; assert version('brambles-aix') == {args.version!r}; assert AixClient(None).send_intent({{}})['reason'] == 'no_key'", cwd=stage)
        commit = run('git', 'rev-parse', 'HEAD', capture=True).strip()
        manifest = {'version': args.version, 'commit': commit, 'tag': args.tag, 'dirty': bool(run('git', 'status', '--porcelain', capture=True).strip()), 'sha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(artifacts.iterdir())}}
        (artifacts / 'verification.json').write_text(json.dumps(manifest, indent=2) + '\n')
        output.mkdir(parents=True, exist_ok=True)
        for path in artifacts.iterdir():
            shutil.copy2(path, output / path.name)
    print(f'PASS: verified {args.version}; artifacts at {output}. Nothing published or tagged.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
