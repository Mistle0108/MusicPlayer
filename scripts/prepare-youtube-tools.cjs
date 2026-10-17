const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const extractZip = require('extract-zip');

const root = path.join(__dirname, '..', 'tools', 'youtube');
async function download(url, file, digest) {
  const response = await fetch(url, { headers: { 'User-Agent': 'MusicPlayer-build' } });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) throw new Error('Download checksum mismatch');
  await fs.writeFile(file, bytes);
}
async function release(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'MusicPlayer-build' } });
  if (!response.ok) throw new Error(`Cannot read ${repo} release`);
  return response.json();
}
async function prepare() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('YouTube bundle requires Windows x64');
  const marker = path.join(root, 'versions.json');
  try {
    await Promise.all(['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'node.exe', 'versions.json'].map(name => fs.access(path.join(root, name))));
    console.log('YouTube tools already prepared.');
    return;
  } catch { /* Prepare the tools for the first build. */ }
  await fs.mkdir(root, { recursive: true });
  const [yt, ff] = await Promise.all([release('yt-dlp/yt-dlp'), release('yt-dlp/FFmpeg-Builds')]);
  const ytAsset = yt.assets.find(asset => asset.name === 'yt-dlp.exe');
  const ffAsset = ff.assets.find(asset => asset.name === 'ffmpeg-master-latest-win64-gpl-shared.zip');
  if (!ytAsset?.digest || !ffAsset?.digest) throw new Error('Missing tool release checksums');
  const zip = path.join(root, 'ffmpeg.zip');
  await Promise.all([
    download(ytAsset.browser_download_url, path.join(root, 'yt-dlp.exe'), ytAsset.digest),
    download(ffAsset.browser_download_url, zip, ffAsset.digest),
    download('https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/LICENSE', path.join(root, 'yt-dlp-LICENSE.txt')),
    download(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, path.join(root, 'node-LICENSE.txt')),
    fs.copyFile(process.execPath, path.join(root, 'node.exe'))
  ]);
  await extractZip(zip, { dir: path.join(root, 'ffmpeg-build') });
  const expanded = path.join(root, 'ffmpeg-build');
  const [folder] = await fs.readdir(expanded);
  const distribution = path.join(expanded, folder);
  for (const file of await fs.readdir(path.join(distribution, 'bin'))) {
    if (file.endsWith('.dll') || ['ffmpeg.exe', 'ffprobe.exe'].includes(file)) await fs.copyFile(path.join(distribution, 'bin', file), path.join(root, file));
  }
  // Preserve the distributor's license and source information next to the binaries.
  for (const file of await fs.readdir(distribution)) {
    if (/license|copying|readme/i.test(file)) await fs.cp(path.join(distribution, file), path.join(root, `ffmpeg-${file}`), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'THIRD-PARTY.txt'), 'yt-dlp: https://github.com/yt-dlp/yt-dlp\nFFmpeg binary and corresponding source/build information: https://github.com/yt-dlp/FFmpeg-Builds\nFFmpeg source: https://ffmpeg.org/download.html\nNode.js source and license: https://nodejs.org/\n', 'utf8');
  await fs.writeFile(marker, JSON.stringify({ ytDlp: yt.tag_name, ffmpeg: ffAsset.digest, node: process.version }, null, 2), 'utf8');
  // Remove only the build archive we just downloaded; keep the original license distribution.
  await fs.unlink(zip);
  console.log('YouTube tools prepared:', root);
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
