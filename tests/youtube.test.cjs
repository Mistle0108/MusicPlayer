const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { YouTubeExtractor, youtubeUrl } = require('../youtube.cjs');
const root = path.resolve(__dirname, '..');
const tools = path.join(root, 'tools', 'youtube');
let temp, fixture;
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-youtube-test-'));
  fixture = path.join(temp, 'fixture.mp3');
  execFileSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-metadata', 'title=추출 테스트', '-metadata', 'artist=테스트', '-codec:a', 'libmp3lame', fixture], { windowsHide: true });
});
after(async () => {
  assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(temp).startsWith('music-youtube-test-'));
  await fs.rm(temp, { recursive: true, force: true });
});

test('YouTube URL validation accepts video links and rejects other protocols, hosts and playlists', () => {
  for (const url of ['https://youtu.be/jNQXAC9IVRw?t=1', 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=unused', 'https://music.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/shorts/jNQXAC9IVRw']) assert.equal(youtubeUrl(url), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  for (const url of ['file:///C:/test', 'http://youtu.be/jNQXAC9IVRw', 'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/playlist?list=abc', 'https://user:password@youtube.com/watch?v=jNQXAC9IVRw', '--exec calc']) assert.throws(() => youtubeUrl(url));
});

test('extraction stages a real MP3, preserves existing files and recovers after saving fails', async () => {
  const worker = new YouTubeExtractor(tools, path.join(temp, 'cache'));
  let parameters;
  worker.run = async args => {
    parameters = args;
    const file = path.join(path.dirname(args[args.indexOf('-o') + 1]), '테스트.mp3');
    await fs.copyFile(fixture, file);
    return `FILE:${JSON.stringify(file)}\n`;
  };
  const ready = await worker.extract('https://youtu.be/jNQXAC9IVRw');
  assert.equal(ready.title, '추출 테스트');
  assert.ok(ready.duration > 1);
  assert.deepEqual(parameters.slice(-2), ['--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
  const destination = path.join(temp, 'manual');
  const existing = path.join(destination, '테스트.mp3');
  await fs.mkdir(destination);
  await fs.writeFile(existing, 'existing user file');
  await assert.rejects(worker.save(destination, async () => { throw new Error('import failed'); }), /import failed/);
  assert.equal(await fs.readFile(existing, 'utf8'), 'existing user file');
  assert.deepEqual(await fs.readdir(destination), ['테스트.mp3']);
  const saved = await worker.save(destination, async () => ({ selectedIds: ['test'], tracks: [] }));
  assert.equal(path.basename(saved.file), '테스트 (1).mp3');
  execFileSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-i', saved.file, '-f', 'null', '-'], { windowsHide: true });
  await assert.rejects(worker.save('relative/path', async () => {}), /전체 경로/);
  worker.run = async () => { throw new Error('network failed'); };
  await assert.rejects(worker.extract('https://youtu.be/jNQXAC9IVRw'), /network failed/);
  assert.equal(worker.busy, false);
  assert.equal(worker.ready, null);
  assert.deepEqual(await fs.readdir(worker.cache), []);
});

test('YouTube popup: manual and automatic saves, folder selection, compact mode and persistence', { timeout: 120000 }, async () => {
  const profile = path.join(temp, 'profile');
  const instance = await electron.launch({
    ...(process.env.MUSIC_PLAYER_TEST_EXE ? { executablePath: process.env.MUSIC_PLAYER_TEST_EXE, args: [] } : { args: [root] }),
    env: { ...process.env, MUSIC_PLAYER_TEST_DATA: profile }
  });
  const main = await instance.firstWindow();
  await main.waitForFunction(() => document.querySelector('#open-youtube svg'));
  const errors = [];
  main.on('pageerror', error => errors.push(error.message));
  try {
  await instance.evaluate(({ app }, fixture) => {
    const require = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/main.cjs`);
    const { YouTubeExtractor } = require(require('node:path').join(app.getAppPath(), 'youtube.cjs'));
    YouTubeExtractor.prototype.run = async function (args, report) {
      if (globalThis.youtubeTestFailure) throw new Error('테스트 네트워크 오류');
      report('다운로드 중 50%');
      const file = require('node:path').join(require('node:path').dirname(args[args.indexOf('-o') + 1]), '추출 테스트.mp3');
      await require('node:fs/promises').copyFile(fixture, file);
      return `FILE:${JSON.stringify(file)}\n`;
    };
  }, fixture);
  async function open() {
    const pending = instance.waitForEvent('window');
    await main.locator('#open-youtube').click();
    const popup = await pending;
    popup.on('pageerror', error => errors.push(error.message));
    await popup.waitForFunction(() => document.querySelector('#youtube-path').value);
    return popup;
  }
    const youtubeButton = await main.locator('#open-youtube').boundingBox();
    const settingsButton = await main.locator('#open-settings').boundingBox();
    assert.ok(youtubeButton.x + youtubeButton.width <= settingsButton.x);
    let popup = await open();
    assert.equal(await popup.locator('#save-youtube').isDisabled(), true);
    assert.equal(await popup.locator('#youtube-auto-save').isChecked(), false);
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await popup.screenshot({ path: path.join(root, 'test-results', 'youtube-popup.png') });
    await popup.locator('#youtube-url').fill('https://example.com/test');
    await popup.locator('#extract-youtube').click();
    await popup.waitForFunction(() => document.querySelector('#youtube-status').classList.contains('error'));
    assert.equal(await popup.locator('#extract-youtube').isEnabled(), true);
    await popup.locator('#youtube-url').fill('https://youtu.be/jNQXAC9IVRw');
    const destination = path.join(temp, 'ui-manual');
    await popup.locator('#youtube-path').fill(destination);
    await popup.locator('#extract-youtube').click();
    await popup.waitForFunction(() => !document.querySelector('#save-youtube').disabled);
    await assert.rejects(fs.access(destination));
    assert.equal(await main.locator('.track-row').count(), 0);
    await popup.locator('#save-youtube').click();
    await popup.waitForFunction(() => document.querySelector('#youtube-status').textContent.includes('라이브러리에 추가했어요'));
    assert.equal(await main.locator('.track-row').count(), 1);
    assert.equal(await main.locator('#player-title').textContent(), '재생할 음악을 선택하세요');
    assert.equal((await fs.readdir(destination)).length, 1);
    await instance.evaluate(({ shell }) => {
      shell.openPath = async folder => { globalThis.youtubeOpenedFolder = folder; return ''; };
    });
    await popup.locator('#open-youtube-folder').click();
    await popup.waitForTimeout(60);
    assert.equal(await instance.evaluate(() => globalThis.youtubeOpenedFolder), destination);
    await popup.locator('#youtube-path').fill(path.join(temp, 'missing-folder'));
    await popup.locator('#open-youtube-folder').click();
    await popup.waitForFunction(() => document.querySelector('#youtube-status').textContent.includes('저장 폴더가 없습니다'));
    assert.equal(await instance.evaluate(() => globalThis.youtubeOpenedFolder), destination);
    const automatic = path.join(temp, 'ui-automatic');
    await instance.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, automatic);
    await popup.locator('#choose-youtube-folder').click();
    await popup.waitForFunction(folder => document.querySelector('#youtube-path').value === folder, automatic);
    await popup.locator('#youtube-auto-save').check();
    await popup.locator('#close-youtube').click();
    await main.locator('#mode-toggle').click();
    await main.waitForFunction(() => document.body.classList.contains('compact'));
    popup = await open();
    assert.equal(await popup.locator('#youtube-path').inputValue(), automatic);
    assert.equal(await popup.locator('#youtube-auto-save').isChecked(), true);
    assert.equal(await popup.evaluate(() => document.body.scrollHeight <= innerHeight), true);
    await popup.locator('#youtube-url').fill('https://youtu.be/jNQXAC9IVRw');
    await popup.locator('#extract-youtube').click();
    await popup.waitForFunction(() => document.querySelector('#youtube-status').textContent.includes('라이브러리에 추가했어요'));
    assert.equal((await fs.readdir(automatic)).length, 1);
    assert.equal(await main.locator('#library-count').textContent(), '2');
    await instance.evaluate(() => { globalThis.youtubeTestFailure = true; });
    await popup.locator('#extract-youtube').click();
    await popup.waitForFunction(() => document.querySelector('#youtube-status').classList.contains('error'));
    assert.equal(await popup.locator('#save-youtube').isDisabled(), true);
    assert.equal(await popup.locator('#extract-youtube').isEnabled(), true);
    assert.equal(await main.locator('#library-count').textContent(), '2');
    await popup.locator('#close-youtube').click();
    await instance.close();
    const stored = JSON.parse(await fs.readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.deepEqual(stored.youtube, { folder: automatic, autoSave: true });
    assert.equal(stored.tracks.length, 2);
    assert.deepEqual(errors, []);
  } finally { await instance.close().catch(() => {}); }
});
