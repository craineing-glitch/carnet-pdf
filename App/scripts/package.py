"""Package the built Windows reader, excluding personal and development data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib

root = Path(__file__).resolve().parents[2]
program = root / 'App'
destination = root / 'dist'
destination.mkdir(exist_ok=True)
archive = destination / 'Carnet-PDF-Windows.zip'

required = [root / 'Carnet.exe', program / 'Stop Reader.exe',
            program / 'runtime/node.exe', program / 'BUILD.json']
for file in required:
    if not file.is_file():
        raise SystemExit(f'Missing {file.relative_to(root)}. Follow the build and packaging steps in README.md.')

files = [root / 'Carnet.exe', program / 'Stop Reader.exe', program / 'Quick Start.txt']
for folder in ['runtime', 'public', 'src', 'server']:
    files.extend(p for p in (program / folder).rglob('*') if p.is_file())
files.extend(program / name for name in [
    'index.html', 'BUILD.json', 'README.md', 'VERIFICATION.md',
    'THIRD-PARTY-NOTICES.txt', 'scripts/launch.mjs', 'scripts/stop.mjs',
    'scripts/watch-desktop.mjs',
])
with ZipFile(archive, 'w', ZIP_DEFLATED, compresslevel=6) as bundle:
    bundle.writestr('Carnet-PDF/Files/', b'')
    for file in sorted(files):
        bundle.write(file, 'Carnet-PDF/' + file.relative_to(root).as_posix())
with ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert not any('/node_modules/' in name or '/tests/' in name or '/desktop/' in name
                   or name.startswith('Carnet-PDF/Files/pdfs/') for name in bundle.namelist())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(destination / 'Carnet-PDF-Windows.sha256.txt').write_text(
    digest + '  Carnet-PDF-Windows.zip\n', encoding='utf-8')
print(f'Packaged {len(files)} files: {archive}. SHA256 {digest}')
