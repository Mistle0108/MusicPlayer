const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function youtubeUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('올바른 유튜브 영상 링크를 입력해주세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('https://로 시작하는 유튜브 영상 링크를 입력해주세요.');
  const host = url.hostname.toLowerCase();
  const youtube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host);
  const id = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0]
    : youtube && url.pathname === '/watch' ? url.searchParams.get('v')
    : youtube && /^\/(shorts|live|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : '';
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('유튜브 영상 한 개의 링크를 입력해주세요.');
  return `https://www.youtube.com/watch?v=${id}`;
}

class YouTubeExtractor {
  constructor(tools, cache) {
    this.tools = tools;
    this.cache = cache;
    this.ready = null;
    this.busy = false;
    this.child = null;
  }
  run(args, report) {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(this.tools, 'yt-dlp.exe'), args, { windowsHide: true, shell: false });
      this.child = child;
      let output = '', errors = '', pending = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith('DOWNLOAD ')) report(`다운로드 중 ${line.slice(9).trim()}`);
          else if (line.includes('[ExtractAudio]')) report('MP3로 변환 중…');
        }
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-16000); });
      child.on('error', () => { this.child = null; reject(new Error('추출 도구를 실행하지 못했습니다. 프로그램을 다시 설치해주세요.')); });
      child.on('close', code => {
        this.child = null;
        if (code === 0) resolve(output);
        else {
          const detail = errors.match(/ERROR:[^\r\n]*/g)?.pop()?.slice(0, 500);
          reject(new Error(detail ? `추출하지 못했습니다. ${detail}` : '추출하지 못했습니다. 링크와 네트워크 상태를 확인해주세요.'));
        }
      });
    });
  }
  async clearOldCache() {
    await fs.mkdir(this.cache, { recursive: true });
    for (const name of await fs.readdir(this.cache)) {
      const target = path.resolve(this.cache, name);
      if (/^extract-[a-zA-Z0-9]+$/.test(name) && path.dirname(target) === path.resolve(this.cache)) await fs.rm(target, { recursive: true, force: true });
    }
  }
  async extract(value, report = () => {}) {
    const url = youtubeUrl(value);
    if (this.busy) throw new Error('이미 추출 또는 저장 중입니다.');
    this.busy = true;
    let directory;
    try {
      if (this.ready) { await fs.rm(this.ready.directory, { recursive: true, force: true }); this.ready = null; }
      report('영상 정보를 확인하고 있어요…');
      await fs.mkdir(this.cache, { recursive: true });
      directory = await fs.mkdtemp(path.join(this.cache, 'extract-'));
      const output = await this.run([
        '--ignore-config', '--no-playlist', '--no-overwrites', '--windows-filenames', '--newline',
        '--progress', '--progress-template', 'download:DOWNLOAD %(progress._percent_str)s',
        '--socket-timeout', '30', '--retries', '2', '--no-simulate',
        '--js-runtimes', `node:${path.join(this.tools, 'node.exe')}`,
        '--ffmpeg-location', this.tools, '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
        '--embed-metadata', '-o', path.join(directory, '%(title).140B [%(id)s].%(ext)s'),
        '--print', 'after_move:FILE:%(filepath)j', '--', url
      ], report);
      const line = output.split(/\r?\n/).find(line => line.startsWith('FILE:'));
      if (!line) throw new Error('추출된 MP3 파일을 찾지 못했습니다.');
      const file = path.resolve(JSON.parse(line.slice(5)));
      if (path.dirname(file) !== path.resolve(directory) || path.extname(file).toLowerCase() !== '.mp3') throw new Error('추출 파일 경로가 올바르지 않습니다.');
      const { parseFile } = await import('music-metadata');
      const metadata = await parseFile(file, { duration: true });
      if (!(metadata.format.duration > 0)) throw new Error('추출된 MP3 파일을 읽지 못했습니다.');
      this.ready = { directory, file, name: path.basename(file), title: metadata.common.title || path.basename(file, '.mp3'), duration: metadata.format.duration };
      directory = null;
      return { name: this.ready.name, title: this.ready.title, duration: this.ready.duration };
    } finally {
      this.busy = false;
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async save(folder, importFile) {
    if (this.busy) throw new Error('이미 추출 또는 저장 중입니다.');
    if (!this.ready) throw new Error('먼저 링크에서 음원을 추출해주세요.');
    if (typeof folder !== 'string' || !path.isAbsolute(folder.trim())) throw new Error('저장할 폴더의 전체 경로를 입력해주세요.');
    this.busy = true;
    let output;
    let copied = false;
    try {
      const destination = path.resolve(folder.trim());
      await fs.mkdir(destination, { recursive: true });
      const name = path.basename(this.ready.name, '.mp3');
      for (let index = 0; ; index++) {
        output = path.join(destination, `${name}${index ? ` (${index})` : ''}.mp3`);
        try { await fs.copyFile(this.ready.file, output, require('node:fs').constants.COPYFILE_EXCL); copied = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const result = await importFile(output);
      if (!result.selectedIds.length) throw new Error('저장한 MP3를 라이브러리에 추가하지 못했습니다.');
      return { ...result, file: output };
    } catch (error) {
      if (copied) await fs.unlink(output).catch(() => {});
      throw error;
    } finally { this.busy = false; }
  }
  cancel() {
    if (this.child) spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => this.child?.kill());
  }
}
module.exports = { YouTubeExtractor, youtubeUrl };
