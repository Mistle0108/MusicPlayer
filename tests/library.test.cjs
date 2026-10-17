const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
let temp, fixtures;
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-library-test-'));
  const rate = 22050, samples = rate * 30;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  fixtures = [];
  for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const file = path.join(temp, `${title}.wav`);
    await fs.writeFile(file, wav);
    fixtures.push({ id: title, path: file, url: pathToFileURL(file).href, title, artist: 'test', album: 'album', duration: 30, format: 'WAV', artwork: '', addedAt: 1 });
  }
});
after(async () => {
  assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(temp).startsWith('music-library-test-'));
  await fs.rm(temp, { recursive: true, force: true });
});
async function launch(profile, initial = null) {
  if (initial) {
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'library.json'), JSON.stringify({ tracks: fixtures, playlists: [], favorites: [], settings: { sort: 'title', queueVersion: 2 }, ...initial }), 'utf8');
  }
  const instance = await electron.launch({
    ...(process.env.MUSIC_PLAYER_TEST_EXE ? { executablePath: process.env.MUSIC_PLAYER_TEST_EXE, args: [] } : { args: [root] }),
    env: { ...process.env, MUSIC_PLAYER_TEST_DATA: profile }
  });
  const page = await instance.firstWindow();
  await page.waitForFunction(() => document.querySelectorAll('.track-row').length > 0);
  return { instance, page };
}
const row = (page, id) => page.locator(`.track-row[data-id="${id}"]`);
const selected = page => page.locator('.track-row.selected').evaluateAll(rows => rows.map(row => row.dataset.id));
const queue = page => page.locator('.queue-row .queue-meta strong').allTextContents();
async function menu(page, id, action) {
  await row(page, id).click({ button: 'right' });
  await page.locator('#track-menu').getByRole('button', { name: action, exact: true }).click();
}

test('library multi-selection applies queue, favorites and file-location actions to all selected songs', { timeout: 120000 }, async () => {
  const { instance, page } = await launch(path.join(temp, 'selection-profile'), {});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await row(page, 'A').click();
    await row(page, 'C').click({ modifiers: ['Control'] });
    assert.deepEqual(await selected(page), ['A', 'C']);
    await menu(page, 'C', '즐겨찾기 추가');
    await page.locator('#favorites-view').click();
    assert.deepEqual(await page.locator('.row-title').allTextContents(), ['A', 'C']);
    await page.locator('[data-view=all]').click();
    await row(page, 'A').click(); await row(page, 'C').click({ modifiers: ['Control'] });
    await menu(page, 'C', '지금 재생');
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .1);
    assert.deepEqual(await queue(page), ['A', 'C']);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('audio').paused);
    await menu(page, 'C', '재생 목록 맨 뒤에 추가');
    assert.deepEqual(await queue(page), ['A', 'C', 'A', 'C']);
    await row(page, 'B').click(); await row(page, 'D').click({ modifiers: ['Control'] });
    await menu(page, 'D', '바로 다음에 재생');
    assert.deepEqual(await queue(page), ['A', 'B', 'D', 'C', 'A', 'C']);

    await row(page, 'B').click(); await row(page, 'E').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selected(page), ['B', 'C', 'D', 'E']);
    await row(page, 'C').click({ modifiers: ['Control'] });
    assert.deepEqual(await selected(page), ['B', 'D', 'E']);
    await row(page, 'D').click({ button: 'right' });
    assert.equal(await page.locator('#track-menu .menu-label').textContent(), '3곡 선택');
    assert.deepEqual(await selected(page), ['B', 'D', 'E']);
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'library-selection-menu.png') });
    await page.keyboard.press('Escape');
    await row(page, 'F').click({ button: 'right' });
    assert.deepEqual(await selected(page), ['F']);
    await page.keyboard.press('Escape');

    await row(page, 'A').click(); await row(page, 'B').click({ modifiers: ['Control'] });
    await menu(page, 'A', '즐겨찾기 추가');
    await menu(page, 'B', '즐겨찾기 해제');
    await page.locator('#favorites-view').click();
    assert.deepEqual(await page.locator('.row-title').allTextContents(), ['C']);
    await page.locator('[data-view=all]').click();
    await instance.evaluate(({ shell }) => { globalThis.shownMusicFiles = []; shell.showItemInFolder = file => globalThis.shownMusicFiles.push(file); });
    await row(page, 'A').click(); await row(page, 'C').click({ modifiers: ['Control'] });
    await row(page, 'C').locator('.row-menu').click();
    assert.equal(await page.locator('#track-menu .menu-label').textContent(), '2곡 선택');
    await page.locator('#track-menu').getByRole('button', { name: '파일 위치 열기', exact: true }).click();
    assert.deepEqual(await instance.evaluate(() => globalThis.shownMusicFiles), [fixtures[0].path, fixtures[2].path]);

    await page.locator('#search').fill('F');
    assert.deepEqual(await selected(page), []);
    await row(page, 'F').click(); await page.keyboard.press('Control+a');
    assert.deepEqual(await selected(page), ['F']);
    await page.locator('#search').fill('');
    await row(page, 'A').click(); await page.keyboard.press('Control+a');
    assert.equal((await selected(page)).length, 6);
    await menu(page, 'C', '지금 재생');
    assert.deepEqual(await queue(page), ['A', 'B', 'C', 'D', 'E', 'F']);
    await row(page, 'B').dblclick();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'B' && !document.querySelector('audio').paused);
    assert.deepEqual(await queue(page), ['B']);
    await row(page, 'D').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'D');
    assert.deepEqual(await queue(page), ['D']);
    assert.deepEqual(errors, []);
  } finally { await instance.close().catch(() => {}); }
});

test('library deletion removes all references, preserves source files and stops a deleted current song', { timeout: 120000 }, async () => {
  const profile = path.join(temp, 'deletion-profile');
  let { instance, page } = await launch(profile, {
    favorites: ['A', 'B', 'C'], playlists: [{ id: 'p', name: '플리', trackIds: ['A', 'B', 'A', 'C', 'D'] }],
    settings: { sort: 'order', currentId: 'A', queue: ['B', 'A', 'C', 'A', 'D'], queueIndex: 3, queueVersion: 2, position: .2 }
  });
  try {
    await page.locator('#play').click();
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .3);
    const position = await page.locator('audio').evaluate(element => element.currentTime);
    await row(page, 'B').click(); await row(page, 'C').click({ modifiers: ['Control'] });
    await menu(page, 'B', '라이브러리에서 삭제');
    await page.waitForFunction(() => document.querySelector('#library-count').textContent === '4');
    assert.deepEqual(await queue(page), ['A', 'A', 'D']);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '1');
    assert.equal(await page.locator('audio').evaluate(element => element.paused), false);
    assert.ok(await page.locator('audio').evaluate(element => element.currentTime) >= position);
    await page.locator('.playlist-open').click();
    assert.deepEqual(await page.locator('.row-title').allTextContents(), ['A', 'A', 'D']);
    await page.locator('#favorites-view').click();
    assert.deepEqual(await page.locator('.row-title').allTextContents(), ['A']);
    await page.locator('[data-view=all]').click();
    await row(page, 'A').locator('.row-menu').click();
    await page.locator('#track-menu').getByRole('button', { name: '라이브러리에서 삭제', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#library-count').textContent === '3');
    assert.deepEqual(await queue(page), ['D']);
    assert.equal(await page.locator('.queue-row.current').count(), 0);
    assert.equal(await page.locator('#player-title').textContent(), '재생할 음악을 선택하세요');
    assert.equal(await page.locator('audio').evaluate(element => element.paused && !element.hasAttribute('src')), true);
    await menu(page, 'D', '라이브러리에서 삭제');
    await page.waitForFunction(() => document.querySelector('#library-count').textContent === '2');
    assert.deepEqual(await queue(page), []);
    for (const track of fixtures) await fs.access(track.path);
    await instance.close();
    const stored = JSON.parse(await fs.readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.deepEqual(stored.tracks.map(track => track.id), ['E', 'F']);
    assert.deepEqual(stored.playlists[0].trackIds, []);
    assert.deepEqual(stored.favorites, []);
    assert.deepEqual(stored.settings.queue, []);
    assert.equal(stored.settings.currentId, null);
    ({ instance, page } = await launch(profile));
    assert.deepEqual(await page.locator('.row-title').allTextContents(), ['E', 'F']);
    assert.deepEqual(await queue(page), []);
  } finally { await instance.close().catch(() => {}); }
});
