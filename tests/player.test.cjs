const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
function wave(seconds = 18) {
  const rate = 22050, samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  // Quiet but decodable audio; this exercises Chromium's real playback pipeline.
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 15), 44 + i * 2);
  return buffer;
}
async function launch(profile) {
  const instance = await electron.launch({
    ...(process.env.MUSIC_PLAYER_TEST_EXE ? { executablePath: process.env.MUSIC_PLAYER_TEST_EXE, args: [] } : { args: [root] }),
    env: { ...process.env, MUSIC_PLAYER_TEST_DATA: profile }
  });
  const page = await instance.firstWindow();
  await page.waitForFunction(() => document.querySelector('#mode-toggle').innerHTML.includes('svg'));
  return { instance, page };
}
async function chooseFiles(instance, files, canceled = false) {
  await instance.evaluate(({ dialog }, result) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.lastOpenOptions = options;
      return { canceled: result.canceled, filePaths: result.files };
    };
  }, { files, canceled });
}
async function addFolder(page, recursive = true) {
  await page.locator('#add-folder').click();
  await page.locator(`#folder-dialog input[value=${recursive ? 'recursive' : 'direct'}]`).check();
  await page.locator('#folder-dialog button[value=select]').click();
}
async function playAllLibrary(page, startIndex = null) {
  await page.locator('.track-row').first().click();
  await page.keyboard.press('Control+A');
  await page.locator('.track-row').first().locator('.row-menu').click();
  await page.locator('#track-menu').getByRole('button', { name: '지금 재생', exact: true }).click();
  if (startIndex !== null) await page.locator('.queue-row').nth(startIndex).dblclick();
}
async function dragPlaylist(page, source, target, after = false) {
  const ids = await page.locator('#playlist-navigation .playlist-entry').evaluateAll(entries => entries.map(entry => entry.dataset.playlist));
  const expected = [...ids];
  const [moving] = expected.splice(source, 1);
  expected.splice(expected.indexOf(ids[target]) + (after ? 1 : 0), 0, moving);
  const start = await page.locator('#playlist-navigation .playlist-entry').nth(source).boundingBox();
  const end = await page.locator('#playlist-navigation .playlist-entry').nth(target).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 30, start.y + start.height / 2, { steps: 5 });
  const targetY = end.y + (after ? end.height - 5 : 5);
  await page.mouse.move(end.x + end.width / 2, targetY, { steps: 10 });
  await page.mouse.move(end.x + end.width / 2 + 1, targetY);
  try {
    await page.waitForFunction(({ target, after }) => document.querySelectorAll('#playlist-navigation .playlist-entry')[target].classList.contains(after ? 'drop-after' : 'drop-before'), { target, after });
    const preview = await page.locator('#playlist-navigation .playlist-entry').nth(target).evaluate((element, after) => {
      const line = getComputedStyle(element, after ? '::after' : '::before');
      return { content: line.content, height: line.height, matchesAccent: line.backgroundColor === getComputedStyle(document.querySelector('#queue-drop-indicator')).backgroundColor };
    }, after);
    assert.deepEqual(preview, { content: '""', height: '5px', matchesAccent: true });
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'playlist-reorder-preview.png') });
    await page.waitForTimeout(60);
  } finally { await page.mouse.up(); }
  await page.waitForFunction(order => [...document.querySelectorAll('#playlist-navigation .playlist-entry')].map(entry => entry.dataset.playlist).join() === order.join(), expected);
}

test('playback shortcuts preserve text editing and control playback outside inputs in both modes', { timeout: 60000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-shortcuts-'));
  const files = [path.join(temp, 'first.wav'), path.join(temp, 'second.wav')];
  await Promise.all(files.map(file => fs.writeFile(file, wave(30))));
  const { instance, page } = await launch(path.join(temp, 'profile'));
  const press = async key => {
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press(key);
  };
  const state = () => page.evaluate(() => ({ paused: audio.paused, volume: audio.volume, muted: audio.muted, shuffle, repeat, queueIndex, currentId, queue: [...queue], favorites: [...favorites], selected: [...selectedTrackIds], tracks: tracks.length, playlists: JSON.stringify(playlists) }));
  async function onlyChanges(key, changes, target, source = page) {
    const before = await state();
    const position = await page.locator('audio').evaluate(el => el.currentTime);
    if (target) await source.locator(target).press(key); else await press(key);
    await page.waitForFunction(expected => Object.entries(expected).every(([key, value]) => ({ volume: audio.volume, muted: audio.muted, shuffle, repeat })[key] === value), changes);
    assert.deepEqual(await state(), { ...before, ...changes });
    assert.ok(Math.abs(await page.locator('audio').evaluate(el => el.currentTime) - position) < .05);
  }
  try {
    await chooseFiles(instance, files);
    await page.locator('#add-files').click();
    await playAllLibrary(page);
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    for (const compact of [false, true]) {
      if (compact) await page.locator('#mode-toggle').click();
      await page.evaluate(() => { audio.pause(); audio.volume = .7; audio.muted = false; });
      const pausedState = await state();
      await press('Space');
      await page.waitForFunction(() => !document.querySelector('audio').paused);
      assert.deepEqual(await state(), { ...pausedState, paused: false });
      await page.locator('#play').press('Space');
      await page.waitForFunction(() => document.querySelector('audio').paused);
      assert.deepEqual(await state(), pausedState);
      await onlyChanges('ArrowUp', { volume: .75 });
      await onlyChanges('ArrowDown', { volume: .7 });
      await onlyChanges('ArrowUp', { volume: .75 }, '#seek');
      await onlyChanges('ArrowDown', { volume: .7 }, '#volume');
      await onlyChanges('m', { muted: true });
      await onlyChanges('m', { muted: false });
      const before = await state();
      await onlyChanges('s', { shuffle: !before.shuffle });
      await onlyChanges('s', { shuffle: before.shuffle });
      for (const expected of ['all', 'one', 'off']) {
        await onlyChanges('r', { repeat: expected });
      }
      await press('Control+ArrowRight');
      await page.waitForFunction(index => queueIndex !== index, before.queueIndex);
      await press('Control+ArrowLeft');
      await page.waitForFunction(index => queueIndex === index, before.queueIndex);
      await page.evaluate(() => audio.pause());
      const protectedState = await state();
      await press('Control+s'); await press('Shift+r');
      await page.locator('body').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', isComposing: true, bubbles: true })));
      await page.locator('body').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 229, bubbles: true })));
      await page.locator('body').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', repeat: true, bubbles: true })));
      assert.deepEqual(await state(), protectedState);
      async function exclusive(target, source = page) {
        const original = await source.locator(target).evaluate(el => ({ text: el.textContent, value: el.value, start: el.selectionStart, end: el.selectionEnd }));
        await onlyChanges('m', { muted: true }, target, source);
        await onlyChanges('m', { muted: false }, target, source);
        await onlyChanges('s', { shuffle: true }, target, source);
        await onlyChanges('s', { shuffle: false }, target, source);
        for (const expected of ['all', 'one', 'off']) await onlyChanges('r', { repeat: expected }, target, source);
        await onlyChanges('ArrowUp', { volume: .75 }, target, source);
        await onlyChanges('ArrowDown', { volume: .7 }, target, source);
        await page.waitForFunction(() => audio.readyState >= 1);
        await page.locator('audio').evaluate(el => { el.currentTime = 10; });
        await page.waitForFunction(() => !audio.seeking);
        await source.locator(target).press('ArrowRight');
        await page.waitForFunction(() => Math.abs(audio.currentTime - 15) < .05);
        await source.locator(target).press('ArrowLeft');
        await page.waitForFunction(() => Math.abs(audio.currentTime - 10) < .05);
        assert.deepEqual(await source.locator(target).evaluate(el => ({ text: el.textContent, value: el.value, start: el.selectionStart, end: el.selectionEnd })), original);
        await source.locator(target).press('Space');
        await page.waitForFunction(() => !audio.paused);
        await source.locator(target).press('Space');
        await page.waitForFunction(() => audio.paused);
      }
      await page.evaluate(() => { selectedTrackIds.clear(); renderTrackSelection(); });
      async function editable(target, source = page) {
        const element = source.locator(target);
        const before = await state();
        const position = await page.locator('audio').evaluate(el => el.currentTime);
        const numeric = await element.evaluate(el => el.type === 'number');
        const originalValue = numeric ? await element.inputValue() : null;
        await element.fill(numeric ? '12' : '');
        if (!numeric) {
          await element.pressSequentially('msr ');
          assert.equal(await element.evaluate(el => el.isContentEditable ? el.textContent.replace(/\u00a0/g, ' ') : el.value), 'msr ');
          await element.press('ArrowLeft');
          assert.equal(await element.evaluate(el => el.isContentEditable ? getSelection().anchorOffset : el.selectionStart), 3);
          await element.press('ArrowRight');
        }
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Control+ArrowLeft', 'Control+ArrowRight', 'Space', 'm', 's', 'r']) await element.press(key);
        const tabPrevented = await element.evaluate(el => {
          const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
          el.dispatchEvent(event);
          return event.defaultPrevented;
        });
        assert.equal(tabPrevented, false);
        assert.deepEqual(await state(), before);
        assert.ok(Math.abs(await page.locator('audio').evaluate(el => el.currentTime) - position) < .05);
        if (numeric) {
          await element.fill(originalValue);
          await element.blur();
          await source.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('저장되었습니다'));
        }
      }
      await page.evaluate(() => document.querySelector('#name-dialog').showModal());
      await editable('#name-input');
      await page.evaluate(() => document.querySelector('#name-dialog').close());
      for (const target of ['textarea', '[contenteditable="true"]']) {
        await page.evaluate(selector => {
          const element = document.createElement(selector === '[contenteditable="true"]' ? 'div' : selector);
          element.id = 'shortcut-edit-test';
          if (selector.startsWith('[')) element.contentEditable = 'true';
          document.body.append(element);
        }, target);
        await editable('#shortcut-edit-test');
        const selectedBefore = (await state()).selected;
        await page.locator('#shortcut-edit-test').press('Control+a');
        assert.deepEqual((await state()).selected, selectedBefore);
        await page.locator('#shortcut-edit-test').evaluate(el => el.remove());
      }
      await page.evaluate(() => {
        $('#track-menu').innerHTML = '<button id="shortcut-menu-test">메뉴 동작</button>';
        window.shortcutMenuClicked = false;
        $('#shortcut-menu-test').onclick = () => { window.shortcutMenuClicked = true; };
        $('#track-menu').hidden = false;
      });
      await exclusive('#shortcut-menu-test');
      assert.equal(await page.evaluate(() => window.shortcutMenuClicked), false);
      await page.evaluate(() => { $('#track-menu').hidden = true; });
      if (!compact) {
        await editable('#search');
        await page.locator('#search').fill('');
        await page.locator('#new-playlist').press('Space');
        await page.waitForFunction(() => !audio.paused);
        assert.equal(await page.locator('#name-dialog').isVisible(), false);
        await page.evaluate(() => audio.pause());
        await page.locator('.track-row').first().press('Space');
        await page.waitForFunction(() => !document.querySelector('audio').paused);
        await page.evaluate(() => audio.pause());
      }
      for (const [button, target] of [['#open-settings', '#seek-seconds'], ['#open-youtube', '#youtube-url']]) {
        const opened = instance.waitForEvent('window');
        await page.locator(button).click();
        const popup = await opened;
        await popup.waitForFunction(() => window.player && document.querySelector('button svg'));
        await editable(target, popup);
        await popup.locator(target).blur();
        const previous = (await state()).queueIndex;
        await popup.keyboard.press('Control+ArrowRight');
        await page.waitForFunction(index => queueIndex !== index, previous);
        await popup.keyboard.press('Control+ArrowLeft');
        await page.waitForFunction(index => queueIndex === index, previous);
        await page.evaluate(() => audio.pause());
        await popup.close();
      }
      await page.evaluate(() => { audio.volume = 1; });
      await press('ArrowUp'); assert.equal((await state()).volume, 1);
      await page.evaluate(() => { audio.volume = 0; });
      await press('ArrowDown'); assert.equal((await state()).volume, 0);
    }
  } finally {
    await instance.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('keyboard seek interval applies immediately and survives restart', { timeout: 60000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-seek-'));
  const profile = path.join(temp, 'profile');
  const file = path.join(temp, 'seek.wav');
  await fs.writeFile(file, wave(30));
  let { instance, page } = await launch(profile);
  const position = () => page.locator('audio').evaluate(el => el.currentTime);
  async function seek(key, expected, target = 'body') {
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1 && !document.querySelector('audio').seeking);
    await page.locator(target).press(key);
    await page.waitForFunction(value => Math.abs(document.querySelector('audio').currentTime - value) < .05, expected);
  }
  try {
    await chooseFiles(instance, [file]);
    await page.locator('#add-files').click();
    await page.locator('.track-row').dblclick();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
    await page.locator('audio').evaluate(el => { el.pause(); el.currentTime = 10; });
    await seek('ArrowRight', 15);
    await seek('ArrowLeft', 10);
    const opened = instance.waitForEvent('window');
    await page.locator('#open-settings').click();
    const settings = await opened;
    await settings.waitForFunction(() => document.querySelectorAll('.theme-preset').length === 5);
    assert.equal(await settings.locator('#seek-seconds').inputValue(), '5');
    await settings.locator('#seek-seconds').fill('7');
    await settings.locator('#seek-seconds').blur();
    await settings.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('저장되었습니다'));
    await settings.locator('#seek-seconds').fill('0');
    await settings.locator('#seek-seconds').blur();
    assert.equal(await settings.locator('#seek-seconds').evaluate(el => el.checkValidity()), false);
    assert.equal((await page.evaluate(() => window.player.preferences())).seekSeconds, 7);
    const closed = settings.waitForEvent('close');
    await settings.locator('#done-settings').click();
    await closed;
    await seek('ArrowRight', 17);
    await seek('ArrowLeft', 10, '#seek');
    await page.locator('#search').fill('seek');
    await page.locator('#search').press('ArrowLeft');
    assert.equal(await page.locator('#search').evaluate(el => el.selectionStart), 3);
    assert.ok(Math.abs(await position() - 10) < .05);
    await page.locator('#search').press('ArrowRight');
    assert.equal(await page.locator('#search').evaluate(el => el.selectionStart), 4);
    await seek('ArrowRight', 17, '#volume');
    await seek('ArrowLeft', 10, '#volume');
    assert.equal(await page.locator('#volume').inputValue(), '70');
    assert.ok(Math.abs(await position() - 10) < .05);
    await page.locator('#mode-toggle').click();
    await seek('ArrowLeft', 3);
    await seek('ArrowLeft', 0);
    await page.locator('audio').evaluate(el => { el.currentTime = 28; });
    await seek('ArrowRight', 30);
    await page.locator('audio').evaluate(el => { el.currentTime = 10; });
    await page.evaluate(() => save(true));
    await instance.close();
    ({ instance, page } = await launch(profile));
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1 && Math.abs(document.querySelector('audio').currentTime - 10) < .05);
    await seek('ArrowRight', 17);
    const reopened = instance.waitForEvent('window');
    await page.locator('#open-settings').click();
    const restored = await reopened;
    await restored.waitForFunction(() => document.querySelector('#seek-seconds').value === '7');
  } finally {
    await instance.close().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('real Windows player: import, playback, modes, playlists, queue and restoration', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  const music = path.join(temp, '음악');
  await fs.mkdir(music);
  await Promise.all(['밤의 산책', '다시, 봄', '길 위의 우리', '스며드는 빛', '조용한 마음'].map(name => fs.writeFile(path.join(music, `${name}.wav`), wave())));
  await fs.writeFile(path.join(music, 'broken.mp3'), 'invalid audio');
  let { instance, page } = await launch(profile);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    assert.equal(await page.locator('#empty-state').isVisible(), true);
    assert.equal(await page.locator('#play').isDisabled(), true);
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('compact'));
    assert.equal(await page.locator('.workspace').isVisible(), false);
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('compact'));

    await chooseFiles(instance, [music]);
    await addFolder(page);
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 5);
    assert.match(await page.locator('#toast').innerText(), /5곡.*1개/);
    await addFolder(page);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('파일 정보를 읽지 못'));
    assert.equal(await page.locator('.track-row').count(), 5);
    await page.locator('#search').fill('없는노래');
    assert.equal(await page.locator('.track-row').count(), 0);
    assert.match(await page.locator('#empty-state h2').innerText(), /검색 결과/);
    await page.locator('#search').fill('');
    await page.locator('.track-row').first().dblclick();
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > 0);
    assert.equal(await page.locator('.queue-row').count(), 1);
    assert.equal(await page.locator('.queue-row.current').count(), 1);
    const playing = await page.locator('#player-title').innerText();
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('compact'));
    const before = await page.locator('audio').evaluate(audio => audio.currentTime);
    await page.waitForFunction(previous => document.querySelector('audio').currentTime > previous + .25, before);
    assert.equal(await page.locator('#player-title').innerText(), playing);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight }));
    assert.equal(dimensions.width, 570);
    assert.ok(dimensions.scrollWidth <= dimensions.width);
    assert.ok(dimensions.scrollHeight <= dimensions.height);
    // Ensure compact volume and transport do not overlap.
    const rectangles = await page.evaluate(() => ({ next: document.querySelector('#repeat').getBoundingClientRect().right, volume: document.querySelector('.audio-controls').getBoundingClientRect().left }));
    assert.ok(rectangles.next <= rectangles.volume, JSON.stringify(rectangles));
    await page.locator('#volume').evaluate(el => { el.value = 35; el.dispatchEvent(new Event('input')); });
    assert.equal(await page.locator('audio').evaluate(audio => audio.volume), .35);
    await page.locator('#seek').evaluate(el => { el.value = 500; el.dispatchEvent(new Event('input')); });
    assert.ok(await page.locator('audio').evaluate(audio => audio.currentTime >= 9));
    await page.locator('#favorite').click();
    await page.locator('#play').click();
    assert.equal(await page.locator('audio').evaluate(audio => audio.paused), true);
    await page.waitForFunction(() => document.querySelector('#play').title === '재생');
    await page.locator('#toast').evaluate(el => el.hidden = true);
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'compact.png') });
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('compact'));
    await page.locator('#new-playlist').click();
    await page.locator('#name-input').fill('테스트 플레이리스트');
    await page.locator('#name-dialog button[value=save]').click();
    await page.getByRole('button', { name: '모든 음악', exact: false }).click();
    await page.locator('.row-menu').first().click();
    assert.equal(await page.locator('#track-menu .menu-label').count(), 0);
    assert.equal(await page.locator('#track-menu').getByRole('button', { name: '테스트 플레이리스트', exact: true }).count(), 0);
    assert.equal(await page.locator('#track-menu').getByRole('button', { name: '+ 새 플레이리스트', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    const dragSource = await page.locator('.track-row').first().boundingBox();
    const dragTarget = await page.locator('.playlist-entry').boundingBox();
    await page.mouse.move(dragSource.x + 80, dragSource.y + 25); await page.mouse.down();
    await page.mouse.move(dragSource.x + 110, dragSource.y + 25, { steps: 5 });
    await page.mouse.move(dragTarget.x + 40, dragTarget.y + 20, { steps: 18 });
    await page.mouse.move(dragTarget.x + 41, dragTarget.y + 20);
    await page.waitForFunction(() => document.querySelector('.playlist-entry.drop-tracks'));
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.playlist-entry.drop-tracks'));
    await page.locator('#playlist-navigation .playlist-open').click();
    assert.equal(await page.locator('.eyebrow').count(), 0);
    assert.equal(await page.locator('.track-row').count(), 1);
    await page.locator('#favorites-view').click();
    assert.equal(await page.locator('.track-row').count(), 1);
    await page.locator('[data-view=all]').click();
    assert.equal(await page.locator('.eyebrow').count(), 0);
    await playAllLibrary(page);
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('audio').paused && document.querySelector('#play').title === '재생');
    const oldQueue = await page.locator('.queue-row').count();
    await page.locator('.queue-remove:not(:disabled)').first().click();
    assert.equal(await page.locator('.queue-row').count(), oldQueue - 1);
    await page.locator('.track-row').first().click();
    await page.locator('.row-menu').first().click();
    await page.locator('#track-menu').getByRole('button', { name: '바로 다음에 재생', exact: true }).click();
    assert.equal(await page.locator('.queue-row').count(), oldQueue);
    await page.locator('#toast').evaluate(el => el.hidden = true);
    await page.screenshot({ path: path.join(root, 'test-results', 'normal.png') });
    await page.waitForFunction(() => document.querySelector('#track-menu').hidden);
    await page.waitForTimeout(500);
    const title = await page.locator('#player-title').innerText();
    const position = await page.locator('audio').evaluate(audio => audio.currentTime);
    await instance.close();
    ({ instance, page } = await launch(profile));
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
    assert.equal(await page.locator('.track-row').count(), 5);
    assert.equal(await page.locator('#player-title').innerText(), title);
    assert.ok(Math.abs(await page.locator('audio').evaluate(audio => audio.currentTime) - position) < 1);
    assert.equal(await page.locator('audio').evaluate(audio => audio.volume), .35);
    assert.equal(await page.locator('audio').evaluate(audio => audio.paused), true);
    assert.equal(await page.locator('#playlist-navigation .playlist-open').count(), 1);
    assert.equal(await page.locator('#favorite').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Renderer errors:', errors);
    console.error('UI message:', await page.locator('#toast').textContent().catch(() => 'unavailable'));
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('playlist Enter and dragging, appearance popup, tray close and persisted preferences', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  const musicFile = path.join(temp, '트레이 재생 확인.wav');
  await fs.writeFile(musicFile, wave(45));
  let { instance, page } = await launch(profile);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    for (const name of ['출근길', '편안한 저녁', '집중할 때']) {
      await page.locator('#new-playlist').click();
      await page.locator('#name-input').fill(name);
      await page.locator('#name-input').press('Enter');
      await page.waitForFunction(expected => document.querySelector('#view-title').textContent === expected, name);
      assert.equal(await page.locator('#view-title').textContent(), name);
    }
    await page.locator('#rename-playlist').click();
    await page.locator('#name-input').fill('집중');
    await page.locator('#name-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#view-title').textContent === '집중');
    assert.equal(await page.locator('#view-title').textContent(), '집중');
    await page.locator('#new-playlist').click();
    await page.locator('#name-input').fill('   ');
    await page.locator('#name-input').press('Enter');
    assert.equal(await page.locator('#name-dialog').evaluate(el => el.open), true);
    await page.locator('#name-input').fill('조합 중');
    await page.locator('#name-input').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await page.locator('#name-dialog').evaluate(el => el.open), true);
    await page.locator('#cancel-name').click();
    assert.equal(await page.locator('#playlist-navigation .playlist-open').count(), 3);
    await page.locator('#new-playlist').click();
    await page.locator('#name-input').fill('취소할 목록');
    await page.locator('#name-input').press('Escape');
    assert.equal(await page.locator('#playlist-navigation .playlist-open').count(), 3);

    await dragPlaylist(page, 2, 0);
    assert.deepEqual(await page.locator('.playlist-name').allTextContents(), ['집중', '출근길', '편안한 저녁']);
    await dragPlaylist(page, 0, 2, true);
    assert.deepEqual(await page.locator('.playlist-name').allTextContents(), ['출근길', '편안한 저녁', '집중']);
    await dragPlaylist(page, 1, 0);
    const order = ['편안한 저녁', '출근길', '집중'];
    assert.deepEqual(await page.locator('.playlist-name').allTextContents(), order);
    assert.equal(await page.locator('.app-icon').evaluate(img => img.naturalWidth), 256);

    // Settings must work even when the parent is the 570px compact player.
    await page.locator('#mode-toggle').click();
    const opened = instance.waitForEvent('window');
    await page.locator('#open-settings').click();
    const settings = await opened;
    await settings.waitForFunction(() => document.querySelectorAll('.theme-preset').length === 5);
    settings.on('pageerror', error => errors.push(error.message));
    settings.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    assert.equal(await settings.locator('#general-panel').isVisible(), true);
    assert.equal(await settings.locator('#theme-panel').isVisible(), false);
    await instance.evaluate(({ Tray }) => {
      const original = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function(menu) { globalThis.trayMenuUnderTest = menu; return original.call(this, menu); };
    });
    await settings.locator('#close-to-tray').check();
    await settings.locator('#theme-tab').click();
    await settings.locator('#appearance-mode').selectOption('dark');
    await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'dark');
    await settings.locator('#preset-ocean').click();
    for (const [key, color] of [['accent', '#d05eb5'], ['background', '#24212b'], ['foreground', '#f1e4d1']]) {
      await settings.locator(`#${key}-hex`).fill(color);
      await settings.locator(`#${key}-hex`).blur();
    }
    await settings.locator('#appearance-font').selectOption('Consolas');
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(36, 33, 43)');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(241, 228, 209)');
    assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Consolas/);
    assert.equal(await page.locator('#play').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(208, 94, 181)');
    await settings.locator('#appearance-mode').selectOption('light');
    assert.equal(await settings.locator('#background-hex').inputValue(), '#f6faff');
    await settings.locator('#appearance-mode').selectOption('dark');
    assert.equal(await settings.locator('#background-hex').inputValue(), '#24212b');
    await page.emulateMedia({ colorScheme: 'light' });
    await settings.emulateMedia({ colorScheme: 'light' });
    await settings.locator('#appearance-mode').selectOption('system');
    await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await settings.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'dark');
    assert.equal(await settings.locator('#background-hex').inputValue(), '#24212b');
    await settings.locator('#appearance-mode').selectOption('dark');
    await settings.locator('#foreground-hex').fill('invalid');
    await settings.locator('#foreground-hex').blur();
    assert.equal(await settings.locator('#foreground-hex').getAttribute('aria-invalid'), 'true');
    await settings.locator('#foreground-hex').fill('#f1e4d1');
    await settings.locator('#foreground-hex').blur();
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await settings.screenshot({ path: path.join(root, 'test-results', 'settings-theme.png') });
    const closed = settings.waitForEvent('close');
    await settings.locator('#done-settings').click();
    await closed;
    await page.screenshot({ path: path.join(root, 'test-results', 'compact-themed.png') });
    await page.locator('#mode-toggle').click();
    await page.locator('[data-view=all]').click();
    await chooseFiles(instance, [musicFile]);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 1);
    await page.locator('.track-row').dblclick();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.locator('#close').click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .1, null, { polling: 100 });
    const windowsState = await instance.evaluate(({ BrowserWindow }) => ({
      count: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible()
    }));
    assert.deepEqual(windowsState, { count: 1, visible: false });
    const before = await page.locator('audio').evaluate(el => el.currentTime);
    await page.waitForFunction(previous => document.querySelector('audio').currentTime > previous + .3, before, { polling: 100 });
    // Exercise the actual Tray menu callbacks, including restoring the window.
    await instance.evaluate(() => {
      globalThis.trayMenuUnderTest.items.find(item => item.label === 'Music Player 열기').click();
    });
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    await page.locator('#play').click();
    await page.screenshot({ path: path.join(root, 'test-results', 'normal-themed.png') });
    const exited = instance.waitForEvent('close');
    await instance.evaluate(() => { globalThis.trayMenuUnderTest.items.find(item => item.label === '종료').click(); });
    await exited;
    ({ instance, page } = await launch(profile));
    assert.deepEqual(await page.locator('.playlist-name').allTextContents(), order);
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(36, 33, 43)');
    assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Consolas/);
    const preferences = await page.evaluate(() => window.player.preferences());
    assert.equal(preferences.closeToTray, true);
    assert.equal(preferences.appearance.theme, 'ocean');
    assert.equal(preferences.appearance.colors.dark.accent, '#d05eb5');
    const reopened = instance.waitForEvent('window');
    await page.locator('#open-settings').click();
    const reopenedSettings = await reopened;
    await reopenedSettings.waitForFunction(() => document.querySelector('#close-to-tray').checked);
    await reopenedSettings.locator('#close-to-tray').uncheck();
    const settingsClosed = reopenedSettings.waitForEvent('close');
    await reopenedSettings.locator('#done-settings').click();
    await settingsClosed;
    const appClosed = instance.waitForEvent('close');
    await page.locator('#close').click();
    await appClosed;
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('remember import paths, multiple files, folder depth, playlist registration and circular navigation', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  const music = path.join(temp, '음악');
  const nested = path.join(music, '하위', '깊은 폴더');
  const other = path.join(temp, '다른 음악');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(other);
  const files = [path.join(music, 'A.wav'), path.join(music, 'B.wav'), path.join(music, '하위', 'C.wav'), path.join(nested, 'D.wav'), path.join(other, 'E.wav')];
  await Promise.all(files.map(file => fs.writeFile(file, wave(20))));
  let { instance, page } = await launch(profile);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.locator('#new-playlist').click();
    await page.locator('#name-input').fill('첫 번째 목록');
    await page.locator('#name-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#add-files-label').textContent === '플리에 추가');
    await chooseFiles(instance, files.slice(0, 2));
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 2);
    assert.equal(await page.locator('#library-count').textContent(), '2');
    assert.ok((await instance.evaluate(() => globalThis.lastOpenOptions.properties)).includes('multiSelections'));
    await chooseFiles(instance, [files[0]]);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('추가할 새 음악이 없어요'));
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    assert.equal(await page.locator('.track-row').count(), 2);
    await page.locator('#new-playlist').click();
    await page.locator('#name-input').fill('두 번째 목록');
    await page.locator('#name-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#view-title').textContent === '두 번째 목록');
    await chooseFiles(instance, [files[0]]);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 1);
    assert.equal(await page.locator('#library-count').textContent(), '2');
    await chooseFiles(instance, [files[4]]);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 2);
    assert.equal(await page.locator('#library-count').textContent(), '3');
    await chooseFiles(instance, [music]);
    await addFolder(page, false);
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    assert.equal(await page.locator('#library-count').textContent(), '3');
    assert.deepEqual((await page.locator('.row-title').allTextContents()).sort(), ['A', 'B', 'E']);
    await chooseFiles(instance, [music]);
    await addFolder(page, true);
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 5);
    assert.equal(await page.locator('#library-count').textContent(), '5');
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    await page.locator('#add-folder').click();
    await page.locator('#cancel-folder').click();
    assert.equal(await page.locator('.track-row').count(), 5);
    await chooseFiles(instance, [], true);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => !document.querySelector('#add-files').disabled);
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    assert.equal(await page.locator('.track-row').count(), 5);
    await page.locator('[data-view=all]').click();
    assert.equal(await page.locator('#add-files-label').textContent(), '파일 추가');
    assert.equal(await page.locator('.track-row').count(), 5);

    await page.locator('#playlist-navigation .playlist-open').nth(1).click();
    await page.locator('#sort').selectOption('title');
    await page.locator('.track-row').first().dblclick();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'A' && !document.querySelector('audio').paused);
    await page.locator('#previous').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'E');
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
    await page.locator('audio').evaluate(el => el.currentTime = 5);
    await page.locator('#previous').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'D');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'E');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'A');
    await page.locator('#search').fill('A');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'B');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'C');
    await page.locator('#search').fill('');
    await page.locator('.track-row').last().dblclick();
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1 && !document.querySelector('audio').paused);
    await page.locator('audio').evaluate(el => el.currentTime = el.duration - .05);
    await page.waitForFunction(() => document.querySelector('audio').ended);
    assert.equal(await page.locator('#player-title').textContent(), 'E');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'A');
    await page.locator('#previous').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'E');
    // Navigation remains limited to the list from which playback started.
    await page.locator('#playlist-navigation .playlist-open').first().click();
    await page.locator('.track-row').first().dblclick();
    await page.locator('#previous').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'B');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#player-title').textContent === 'A');
    await page.locator('#play').click();
    await instance.close();
    ({ instance, page } = await launch(profile));
    await chooseFiles(instance, [], true);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => !document.querySelector('#add-files').disabled);
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    await addFolder(page, false);
    await page.waitForFunction(() => !document.querySelector('#add-folder').disabled);
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    await page.locator('#playlist-navigation .playlist-open').nth(1).click();
    assert.equal(await page.locator('.track-row').count(), 5);
    assert.equal(await page.locator('#library-count').textContent(), '5');
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('shared import location, sidebar play button and a stable full playback queue', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  const music = path.join(temp, '음악');
  const other = path.join(temp, '다른 폴더');
  await fs.mkdir(music); await fs.mkdir(other);
  const files = ['A', 'B', 'C'].map(name => path.join(music, `${name}.wav`));
  await Promise.all([...files, path.join(other, 'D.wav')].map(file => fs.writeFile(file, wave(40))));
  let { instance, page } = await launch(profile);
  const errors = [];
  const observe = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page);
  const queueTitles = () => page.locator('.queue-row .queue-meta strong').allTextContents();
  const expectCurrent = async name => {
    await page.waitForFunction(expected => document.querySelector('#player-title').textContent === expected && document.querySelector('.queue-row.current .queue-meta strong')?.textContent === expected, name);
    assert.equal(await page.locator('.queue-row.current').count(), 1);
    assert.equal(await page.locator('.queue-row[aria-current=true]').count(), 1);
  };
  try {
    await chooseFiles(instance, files);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    await chooseFiles(instance, [other]);
    await addFolder(page, false);
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 4);
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    const longName = '아주 긴 플레이리스트 이름이 사이드바의 공간을 넘어가도 재생 버튼이 보이는 목록';
    await page.locator('#new-playlist').click();
    await page.locator('#name-input').fill(longName);
    await page.locator('#name-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#view-title').textContent.includes('아주 긴'));
    await chooseFiles(instance, files);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), other);
    const layout = await page.locator('.playlist-entry').evaluate(row => {
      const label = row.querySelector('.playlist-name');
      const open = row.querySelector('.playlist-open');
      const play = row.querySelector('.playlist-play');
      return { clipped: label.scrollWidth > label.clientWidth, ellipsis: getComputedStyle(label).textOverflow, openIcons: open.querySelectorAll('svg').length, playVisible: play.getBoundingClientRect().right <= row.getBoundingClientRect().right, overflow: row.scrollWidth > row.clientWidth };
    });
    assert.deepEqual(layout, { clipped: true, ellipsis: 'ellipsis', openIcons: 0, playVisible: true, overflow: false });
    await page.locator('#sort').selectOption('title');
    await page.locator('[data-view=all]').click();
    await page.locator('.playlist-play').click();
    await expectCurrent('A');
    assert.deepEqual(await queueTitles(), ['A', 'B', 'C']);
    assert.equal(await page.locator('#view-title').textContent(), longName);
    for (let index = 0; index < 8; index++) {
      await page.locator('#previous').click();
      assert.deepEqual(await queueTitles(), ['A', 'B', 'C']);
    }
    for (let index = 0; index < 7; index++) {
      await page.locator('#next').click();
      assert.deepEqual(await queueTitles(), ['A', 'B', 'C']);
    }
    await page.locator('.queue-row').nth(1).dblclick();
    await expectCurrent('B');
    assert.deepEqual(await queueTitles(), ['A', 'B', 'C']);
    await page.locator('#next').click(); await expectCurrent('C');
    await page.locator('#next').click(); await expectCurrent('A');
    await page.locator('.track-row').nth(2).locator('.row-menu').click();
    await page.locator('#track-menu').getByRole('button', { name: '바로 다음에 재생', exact: true }).click();
    assert.deepEqual(await queueTitles(), ['A', 'C', 'B', 'C']);
    await page.locator('#next').click(); await expectCurrent('C');
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '1');
    await page.locator('#previous').click(); await expectCurrent('A');
    assert.deepEqual(await queueTitles(), ['A', 'C', 'B', 'C']);
    await page.locator('#next').click(); await expectCurrent('C');
    await page.locator('#next').click(); await expectCurrent('B');
    await page.locator('#next').click(); await expectCurrent('C');
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '3');
    await page.locator('#play').click();
    await page.locator('#toast').evaluate(element => element.hidden = true);
    await page.screenshot({ path: path.join(root, 'test-results', 'queue-and-playlists.png') });
    await instance.close();
    ({ instance, page } = await launch(profile)); observe(page);
    await expectCurrent('C');
    assert.deepEqual(await queueTitles(), ['A', 'C', 'B', 'C']);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '3');
    await chooseFiles(instance, [], true);
    await addFolder(page, false);
    await page.waitForFunction(() => !document.querySelector('#add-folder').disabled);
    assert.equal(await instance.evaluate(() => globalThis.lastOpenOptions.defaultPath), music);
    // Reorder a currently playing occurrence without changing the audio selection.
    const start = await page.locator('.queue-row').nth(3).boundingBox();
    const end = await page.locator('.queue-row').first().boundingBox();
    await page.mouse.move(start.x + 40, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y + start.height / 2, { steps: 5 });
    await page.mouse.move(end.x + 40, end.y + end.height / 2, { steps: 12 });
    await page.mouse.move(end.x + 41, end.y + end.height / 2); await page.waitForTimeout(60); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.queue-row.current')?.dataset.index === '0');
    assert.deepEqual(await queueTitles(), ['C', 'A', 'C', 'B']);
    await expectCurrent('C');
    await page.locator('.queue-row').nth(1).dblclick(); await expectCurrent('A');
    await page.locator('.queue-remove').first().click();
    await expectCurrent('A');
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '0');
    assert.deepEqual(await queueTitles(), ['A', 'C', 'B']);
    await page.locator('#clear-queue').click();
    assert.deepEqual(await queueTitles(), []);
    assert.equal(await page.locator('audio').evaluate(element => element.paused && !element.hasAttribute('src')), true);
    assert.equal(await page.locator('#player-title').textContent(), '재생할 음악을 선택하세요');
    assert.equal(await page.locator('#previous').isDisabled(), true);
    assert.equal(await page.locator('#next').isDisabled(), true);
    await instance.close();
    // Migrate a pre-0.4 profile containing the previous-track duplication bug.
    const storePath = path.join(profile, 'library.json');
    const stored = JSON.parse(await fs.readFile(storePath, 'utf8'));
    const ids = ['A', 'B', 'C'].map(title => stored.tracks.find(track => track.title === title).id);
    delete stored.settings.queueVersion; delete stored.settings.queueIndex;
    stored.settings.playbackOrder = ids;
    stored.settings.queue = [ids[1], ids[1], ids[2], ids[0]];
    stored.settings.currentId = ids[1];
    await fs.writeFile(storePath, JSON.stringify(stored), 'utf8');
    ({ instance, page } = await launch(profile)); observe(page);
    await expectCurrent('B');
    assert.deepEqual(await queueTitles(), ['A', 'B', 'C']);
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('drag songs, albums and artists from the library into playlists', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  await fs.mkdir(profile);
  const { pathToFileURL } = require('node:url');
  const fixtures = [];
  for (const [index, title] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    const file = path.join(temp, `${title}.wav`);
    await fs.writeFile(file, wave(40));
    fixtures.push({ id: `fixture-${title}`, path: file, url: pathToFileURL(file).href, title, artist: index < 3 ? '첫 아티스트' : '다른 아티스트', album: index < 2 ? '첫 앨범' : index === 2 ? '둘째 앨범' : '셋째 앨범', duration: 40, format: 'WAV', sampleRate: 22050, artwork: '', addedAt: index });
  }
  const playlists = ['곡 모음', '앨범 모음', '아티스트 모음'].map((name, index) => ({ id: `list-${index}`, name, trackIds: [] }));
  await fs.writeFile(path.join(profile, 'library.json'), JSON.stringify({ tracks: fixtures, playlists, favorites: [], settings: { sort: 'title' } }), 'utf8');
  let { instance, page } = await launch(profile);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const target = index => page.locator('.playlist-entry').nth(index);
  async function dragMusic(source, index) {
    const start = await source.boundingBox();
    const end = await target(index).boundingBox();
    await page.mouse.move(start.x + start.width * .45, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + start.width * .45 + 25, start.y + start.height / 2, { steps: 5 });
    await page.mouse.move(end.x + 35, end.y + end.height / 2, { steps: 16 });
    await page.mouse.move(end.x + 36, end.y + end.height / 2);
    await page.waitForFunction(() => document.querySelectorAll('.playlist-entry.drop-tracks').length === 1);
    assert.equal(await target(index).evaluate(element => element.classList.contains('drop-tracks')), true);
    await page.waitForTimeout(60); await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.drop-tracks'));
    assert.equal(await page.locator('#library-count').textContent(), '5');
  }
  try {
    await page.locator('.track-row').first().dblclick();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play').title === '재생');
    const queue = await page.locator('.queue-row .queue-meta strong').allTextContents();
    await dragMusic(page.locator('.track-row[data-id="fixture-A"]'), 0);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('곡 모음에 1곡'));
    assert.equal(await target(0).locator('.playlist-play').isEnabled(), true);
    assert.equal(await page.locator('#view-title').textContent(), '모든 음악');
    await dragMusic(page.locator('.track-row[data-id="fixture-A"]'), 0);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('이미 이 플레이리스트'));
    await page.locator('[data-view=albums]').click();
    await dragMusic(page.locator('.album-card[data-group="첫 앨범"]'), 1);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('앨범 모음에 2곡'));
    assert.equal(await page.locator('#view-title').textContent(), '앨범');
    await page.locator('.album-card[data-group="둘째 앨범"]').click();
    await dragMusic(page.locator('.track-row[data-id="fixture-C"]'), 0);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('곡 모음에 1곡'));
    assert.equal(await page.locator('#view-title').textContent(), '둘째 앨범');
    await page.locator('[data-view=artists]').click();
    await dragMusic(page.locator('.album-card[data-group="첫 아티스트"]'), 2);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('아티스트 모음에 3곡'));
    assert.equal(await page.locator('#view-title').textContent(), '아티스트');
    await dragMusic(page.locator('.album-card[data-group="첫 아티스트"]'), 2);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('이미 이 플레이리스트'));
    await page.locator('.album-card[data-group="다른 아티스트"]').click();
    await dragMusic(page.locator('.track-row[data-id="fixture-D"]'), 0);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('곡 모음에 1곡'));
    assert.equal(await page.locator('#view-title').textContent(), '다른 아티스트');
    assert.deepEqual(await page.locator('.queue-row .queue-meta strong').allTextContents(), queue);
    assert.equal(await page.locator('#player-title').textContent(), 'A');
    assert.equal(await page.locator('audio').evaluate(element => element.paused), true);
    await instance.close();
    ({ instance, page } = await launch(profile));
    for (const [index, expected] of [[0, ['A', 'C', 'D']], [1, ['A', 'B']], [2, ['A', 'B', 'C']]]) {
      await target(index).locator('.playlist-open').click();
      assert.deepEqual(await page.locator('.row-title').allTextContents(), expected);
    }
    assert.equal(await page.locator('#library-count').textContent(), '5');
    assert.deepEqual(await page.locator('.queue-row .queue-meta strong').allTextContents(), queue);
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('playlist tracks drag into the queue and retain reordered entries after restart', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  await fs.mkdir(profile);
  const { pathToFileURL } = require('node:url');
  const fixtures = [];
  for (const [index, title] of ['A', 'B', 'C', 'D'].entries()) {
    const file = path.join(temp, `${title}.wav`);
    await fs.writeFile(file, wave(40));
    fixtures.push({ id: title, path: file, url: pathToFileURL(file).href, title, artist: title === 'D' ? 'hidden' : 'visible', album: 'test', duration: 40, format: 'WAV', sampleRate: 22050, artwork: '', addedAt: index });
  }
  await fs.writeFile(path.join(profile, 'library.json'), JSON.stringify({ tracks: fixtures, playlists: [{ id: 'test', name: '플리', trackIds: ['A', 'C', 'A', 'B', 'D'] }, { id: 'empty', name: '빈 목록', trackIds: [] }], favorites: [], settings: { sort: 'title' } }), 'utf8');
  let { instance, page } = await launch(profile);
  const errors = [];
  const observe = () => page.on('pageerror', error => errors.push(error.message));
  observe();
  const titles = () => page.locator('.row-title').allTextContents();
  const queueTitles = () => page.locator('.queue-row .queue-meta strong').allTextContents();
  async function drag(source, destination, after = false, toQueue = false) {
    await page.bringToFront(); await page.mouse.up();
    const start = await source.boundingBox();
    const end = await destination.boundingBox();
    const y = end.y + end.height * (after ? .8 : .2);
    await page.mouse.move(start.x + 80, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + 110, start.y + start.height / 2, { steps: 5 });
    await page.mouse.move(end.x + 80, y, { steps: 18 });
    await page.mouse.move(end.x + 81, y);
    try {
      if (toQueue) await page.waitForFunction(() => !document.querySelector('#queue-drop-indicator').hidden);
      else await page.waitForFunction(() => document.querySelector('.track-row.drop-before, .track-row.drop-after'));
      await page.waitForTimeout(60);
    } finally { await page.mouse.up(); }
    await page.waitForFunction(() => !document.querySelector('.track-row.drop-before, .track-row.drop-after, .drop-tracks'));
  }
  try {
    await page.locator('.playlist-open[title="플리"]').click();
    assert.deepEqual(await titles(), ['A', 'A', 'B', 'C', 'D']);
    assert.equal((await page.locator('body').innerText()).includes('나의 음악, 나의 공간'), false);
    await page.locator('.track-row').nth(2).dblclick();
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .1);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('audio').paused && document.querySelector('#play').title === '재생');
    const position = await page.locator('audio').evaluate(element => element.currentTime);
    await drag(page.locator('.track-row').nth(3), page.locator('.queue-row').first(), false, true);
    const queue = ['C', 'A', 'A', 'B', 'C', 'D'];
    assert.deepEqual(await queueTitles(), queue);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '3');
    assert.deepEqual(await titles(), ['A', 'A', 'B', 'C', 'D']);
    await drag(page.locator('.track-row').nth(1), page.locator('.track-row').nth(3), true);
    assert.deepEqual(await titles(), ['A', 'B', 'C', 'A', 'D']);
    assert.equal(await page.locator('#sort').inputValue(), 'order');
    await page.locator('#search').fill('visible');
    await drag(page.locator('.track-row').first(), page.locator('.track-row').nth(2), true);
    assert.deepEqual(await titles(), ['B', 'C', 'A', 'A']);
    await page.locator('#search').fill('');
    assert.deepEqual(await titles(), ['B', 'C', 'A', 'A', 'D']);
    await page.locator('#sort').selectOption('title');
    await drag(page.locator('.track-row').last(), page.locator('.track-row').first());
    assert.deepEqual(await titles(), ['D', 'A', 'A', 'B', 'C']);
    assert.deepEqual(await queueTitles(), queue);
    assert.equal(await page.locator('#player-title').textContent(), 'B');
    assert.equal(await page.locator('audio').evaluate(element => element.currentTime), position);
    // A whole playlist inserts its stored order, including duplicates, despite the view filter.
    await page.locator('#search').fill('visible');
    await drag(page.locator('.playlist-entry[data-playlist="test"]'), page.locator('.queue-row.current'), false, true);
    queue.splice(3, 0, 'D', 'A', 'A', 'B', 'C');
    assert.deepEqual(await queueTitles(), queue);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '8');
    assert.equal(await page.locator('#player-title').textContent(), 'B');
    assert.equal(await page.locator('audio').evaluate(element => element.currentTime), position);
    await drag(page.locator('.playlist-entry[data-playlist="empty"]'), page.locator('.queue-row').first(), false, true);
    assert.deepEqual(await queueTitles(), queue);
    await dragPlaylist(page, 0, 1, true);
    assert.deepEqual(await page.locator('.playlist-name').allTextContents(), ['빈 목록', '플리']);
    await instance.close();
    ({ instance, page } = await launch(profile)); observe();
    await page.locator('.playlist-open[title="플리"]').click();
    assert.deepEqual(await titles(), ['D', 'A', 'A', 'B', 'C']);
    assert.deepEqual(await queueTitles(), queue);
    assert.deepEqual(await page.locator('.playlist-name').allTextContents(), ['빈 목록', '플리']);
    assert.equal(await page.locator('#library-count').textContent(), '4');
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('drag library items into the queue and save its exact order as a new playlist', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  const files = ['A', 'B', 'C'].map(name => path.join(temp, `${name}.wav`));
  await Promise.all(files.map(file => fs.writeFile(file, wave(40))));
  let { instance, page } = await launch(profile);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const queueTitles = () => page.locator('.queue-row .queue-meta strong').allTextContents();
  async function dragToQueue(source, destination, fraction = null, expectedIndex = null, cancel = false) {
    await page.bringToFront();
    await page.mouse.up();
    const start = await source.boundingBox();
    const end = await destination.boundingBox();
    await page.mouse.move(start.x + start.width * .45, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + start.width * .45 + 25, start.y + start.height / 2, { steps: 5 });
    await page.waitForFunction(() => document.querySelector('.music-dragging, .queue-row.dragging'), null, { timeout: 2000 });
    const targetY = end.y + (fraction === null ? Math.min(end.height / 2, 70) : end.height * fraction);
    await page.mouse.move(end.x + 45, targetY, { steps: 18 });
    await page.mouse.move(end.x + 46, targetY);
    try {
      await page.waitForFunction(() => document.querySelector('.queue-panel').classList.contains('drop-tracks'), null, { timeout: 5000 });
      assert.equal(await page.locator('#queue-drop-indicator').isVisible(), true);
      if (expectedIndex !== null) assert.equal(await page.locator('#queue-drop-indicator').getAttribute('data-index'), String(expectedIndex));
      assert.equal(await page.locator('#queue-drop-indicator').evaluate(element => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--blue)';
        element.append(probe);
        const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      }), true);
      if (expectedIndex === 2) await page.screenshot({ path: path.join(root, 'test-results', 'queue-insertion-preview.png') });
      if (cancel) {
        const main = await page.locator('main').boundingBox();
        await page.mouse.move(main.x + 100, main.y + 10, { steps: 10 });
        await page.waitForFunction(() => document.querySelector('#queue-drop-indicator').hidden);
      }
      await page.waitForTimeout(60);
    } finally { await page.mouse.up(); }
    await page.waitForFunction(() => !document.querySelector('.queue-panel').classList.contains('drop-tracks'));
    assert.equal(await page.locator('#queue-drop-indicator').isVisible(), false);
  }
  try {
    assert.equal(await page.locator('#save-queue').isDisabled(), true);
    await chooseFiles(instance, files);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    await page.locator('#sort').selectOption('title');
    await dragToQueue(page.locator('.track-row').nth(1), page.locator('.queue-panel'), null, 0);
    assert.deepEqual(await queueTitles(), ['B']);
    assert.equal(await page.locator('#save-queue').isEnabled(), true);
    assert.equal(await page.locator('#player-title').textContent(), '재생할 음악을 선택하세요');
    await page.locator('#play').click();
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .1);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play').title === '재생');
    const position = await page.locator('audio').evaluate(element => element.currentTime);
    // Dropping above the current row inserts before it without changing playback.
    await dragToQueue(page.locator('.track-row').first(), page.locator('.queue-row.current'), .25, 0);
    assert.deepEqual(await queueTitles(), ['A', 'B']);
    await page.locator('[data-view=albums]').click();
    await dragToQueue(page.locator('.album-card').first(), page.locator('.queue-panel'));
    assert.deepEqual(await queueTitles(), ['A', 'B', 'A', 'B', 'C']);
    await page.locator('[data-view=artists]').click();
    await dragToQueue(page.locator('.album-card').first(), page.locator('.queue-panel'));
    const expected = ['A', 'B', 'A', 'B', 'C', 'A', 'B', 'C'];
    assert.deepEqual(await queueTitles(), expected);
    assert.equal(await page.locator('#library-count').textContent(), '3');
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '1');
    assert.equal(await page.locator('#player-title').textContent(), 'B');
    assert.equal(await page.locator('audio').evaluate(element => element.currentTime), position);
    await page.locator('[data-view=all]').click();
    await dragToQueue(page.locator('.track-row').last(), page.locator('.queue-row').nth(1), .75, 2, true);
    assert.deepEqual(await queueTitles(), expected);
    await dragToQueue(page.locator('.track-row').last(), page.locator('.queue-row').nth(1), .75, 2);
    expected.splice(2, 0, 'C');
    assert.deepEqual(await queueTitles(), expected);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '1');
    assert.equal(await page.locator('audio').evaluate(element => element.currentTime), position);
    await dragToQueue(page.locator('.queue-row').first(), page.locator('.queue-row').last(), .75, 9);
    assert.deepEqual(await queueTitles(), [...expected.slice(1), expected[0]]);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '0');
    await dragToQueue(page.locator('.queue-row').last(), page.locator('.queue-row').first(), .25, 0);
    assert.deepEqual(await queueTitles(), expected);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '1');
    assert.equal(await page.locator('audio').evaluate(element => element.currentTime), position);
    await page.locator('#save-queue').click();
    await page.locator('#name-input').fill('저장 취소');
    await page.locator('#name-input').press('Escape');
    assert.equal(await page.locator('.playlist-entry').count(), 0);
    assert.deepEqual(await queueTitles(), expected);
    await page.locator('#save-queue').click();
    await page.locator('#name-input').fill('재생 목록에서 만든 플리');
    await page.locator('#name-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('재생 목록 9곡을 저장'));
    assert.equal(await page.locator('#view-title').textContent(), '재생 목록에서 만든 플리');
    assert.equal(await page.locator('#sort').inputValue(), 'order');
    assert.deepEqual(await page.locator('.row-title').allTextContents(), expected);
    assert.deepEqual(await queueTitles(), expected);
    assert.equal(await page.locator('audio').evaluate(element => element.currentTime), position);
    assert.equal(await page.locator('audio').evaluate(element => element.paused), true);
    await page.locator('.track-row').last().dblclick();
    await page.waitForFunction(() => document.querySelector('.queue-row.current')?.dataset.index === '8');
    assert.equal(await page.locator('#player-title').textContent(), 'C');
    await instance.close();
    const stored = JSON.parse(await fs.readFile(path.join(profile, 'library.json'), 'utf8'));
    const titles = new Map(stored.tracks.map(track => [track.id, track.title]));
    assert.deepEqual(stored.playlists[0].trackIds.map(id => titles.get(id)), expected);
    assert.equal(stored.settings.queueIndex, 8);
    ({ instance, page } = await launch(profile));
    await page.locator('.playlist-open').click();
    assert.deepEqual(await page.locator('.row-title').allTextContents(), expected);
    assert.deepEqual(await queueTitles(), expected);
    assert.equal(await page.locator('.queue-row.current').getAttribute('data-index'), '8');
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('playback-list toolbar and compact expansion preserve the same playing list', { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'music-player-test-'));
  const profile = path.join(temp, 'profile');
  const files = ['A', 'B', 'C', 'D', 'E', 'F'].map(name => path.join(temp, `${name}.wav`));
  await Promise.all(files.map(file => fs.writeFile(file, wave(40))));
  const { instance, page } = await launch(profile);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    assert.equal(await page.locator('.queue-panel h2').count(), 0);
    assert.equal(await page.evaluate(() => {
      const expected = document.createElement('div');
      expected.innerHTML = window.PlayerIcons.compact;
      return document.querySelector('#mode-toggle svg').isEqualNode(expected.firstElementChild);
    }), true);
    assert.equal(await page.locator('.queue-summary .section-label').textContent(), '지금 재생 중');
    assert.equal(await page.locator('#save-queue').isDisabled(), true);
    assert.equal(await page.locator('#clear-queue').isDisabled(), true);
    await chooseFiles(instance, files);
    await page.locator('#add-files').click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 6);
    await page.locator('#sort').selectOption('title');
    await playAllLibrary(page, 2);
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .1);
    const toolbar = await page.evaluate(() => {
      const save = document.querySelector('#save-queue').getBoundingClientRect();
      const clear = document.querySelector('#clear-queue').getBoundingClientRect();
      const panel = document.querySelector('.queue-panel').getBoundingClientRect();
      const summary = document.querySelector('.queue-now').getBoundingClientRect();
      const label = document.querySelector('.queue-summary .section-label').getBoundingClientRect();
      const count = document.querySelector('#queue-count').getBoundingClientRect();
      return { sameRow: Math.abs(save.top - clear.top) < 1, ordered: save.right <= clear.left, withinPanel: save.left >= panel.left && clear.right <= panel.right, aboveSummary: clear.bottom < summary.top, countAligned: Math.abs(label.top - count.top) < 2 && count.left > label.right && Math.abs(count.right - summary.right) < 1 };
    });
    assert.deepEqual(toolbar, { sameRow: true, ordered: true, withinPanel: true, aboveSummary: true, countAligned: true });
    assert.equal(await page.locator('#save-queue svg').isVisible(), true);
    assert.equal(await page.locator('#clear-queue svg').isVisible(), true);
    const highlight = await page.locator('.queue-row.current').evaluate(element => {
      const style = getComputedStyle(element);
      return { shadow: style.boxShadow, border: style.borderLeftWidth, background: style.backgroundColor };
    });
    assert.equal(highlight.shadow, 'none'); assert.equal(highlight.border, '0px');
    assert.notEqual(highlight.background, 'rgba(0, 0, 0, 0)');
    assert.equal((await page.locator('body').innerText()).includes('대기열'), false);
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'playback-list-normal.png') });
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('compact') && innerHeight === 270);
    assert.equal(await page.locator('#compact-queue-toggle').isVisible(), true);
    assert.equal(await page.locator('.workspace').isVisible(), false);
    assert.equal(await page.locator('#compact-queue-count').textContent(), '6곡');
    await page.screenshot({ path: path.join(root, 'test-results', 'playback-list-compact-collapsed.png') });
    const before = await page.locator('audio').evaluate(element => element.currentTime);
    await page.locator('#compact-queue-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('queue-expanded') && innerHeight > 270);
    await page.waitForFunction(previous => document.querySelector('audio').currentTime > previous, before);
    assert.equal(await page.locator('.queue-panel').isVisible(), true);
    assert.equal(await page.locator('main').isVisible(), false);
    assert.equal(await page.locator('#save-queue').isVisible(), false);
    assert.equal(await page.locator('#clear-queue').isVisible(), false);
    assert.equal(await page.locator('#compact-queue-toggle').getAttribute('aria-expanded'), 'true');
    const expanded = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight, toggleBottom: document.querySelector('#compact-queue-toggle').getBoundingClientRect().bottom, panelTop: document.querySelector('.queue-panel').getBoundingClientRect().top }));
    assert.equal(expanded.width, 570);
    assert.ok(expanded.scrollWidth <= expanded.width); assert.ok(expanded.scrollHeight <= expanded.height);
    assert.equal(expanded.toggleBottom, expanded.panelTop);
    assert.equal(await page.locator('.queue-row').count(), 6);
    assert.equal(await page.locator('.queue-row.current .queue-meta strong').textContent(), 'C');
    await page.screenshot({ path: path.join(root, 'test-results', 'playback-list-compact-expanded.png') });
    await page.bringToFront();
    await page.mouse.up();
    const dragStart = await page.locator('.queue-row').first().boundingBox();
    const dragEnd = await page.locator('.queue-row').last().boundingBox();
    await page.mouse.move(dragStart.x + 60, dragStart.y + 20);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 90, dragStart.y + 20, { steps: 5 });
    await page.mouse.move(dragEnd.x + 90, dragEnd.y + dragEnd.height * .8, { steps: 18 });
    await page.mouse.move(dragEnd.x + 91, dragEnd.y + dragEnd.height * .8);
    try {
      await page.waitForFunction(() => !document.querySelector('#queue-drop-indicator').hidden && document.querySelector('#queue-drop-indicator').dataset.index === '6');
      assert.equal(await page.locator('#queue-drop-indicator').getAttribute('data-index'), '6');
      await page.screenshot({ path: path.join(root, 'test-results', 'compact-queue-insertion-preview.png') });
    } finally { await page.mouse.up(); }
    assert.deepEqual(await page.locator('.queue-row .queue-meta strong').allTextContents(), ['B', 'C', 'D', 'E', 'F', 'A']);
    assert.equal(await page.locator('#queue-drop-indicator').isVisible(), false);
    assert.equal(await page.locator('audio').evaluate(element => element.paused), false);
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('.queue-row.current .queue-meta strong')?.textContent === 'D');
    await page.locator('#compact-queue-toggle').click();
    await page.waitForFunction(() => innerHeight === 270 && !document.body.classList.contains('queue-expanded'));
    assert.equal(await page.locator('#player-title').textContent(), 'D');
    assert.equal(await page.locator('audio').evaluate(element => element.paused), false);
    await page.locator('#compact-queue-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('queue-expanded'));
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('compact') && innerWidth === 1400);
    assert.equal(await page.locator('.queue-summary').isVisible(), true);
    assert.equal(await page.locator('.queue-row').count(), 6);
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('compact') && document.body.classList.contains('queue-expanded'));
    assert.equal(await page.locator('#save-queue').count(), 1);
    assert.equal(await page.locator('#save-queue').isVisible(), false);
    assert.equal(await page.locator('#clear-queue').isVisible(), false);
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('compact'));
    await page.locator('#save-queue').click();
    await page.locator('#name-input').fill('기본 모드에서 저장');
    await page.locator('#name-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('재생 목록 6곡을 저장'));
    assert.equal(await page.locator('#player-title').textContent(), 'D');
    assert.equal(await page.locator('.queue-row').count(), 6);
    await page.locator('#clear-queue').click();
    assert.equal(await page.locator('.queue-row').count(), 0);
    assert.equal(await page.locator('#compact-queue-count').textContent(), '0곡');
    assert.equal(await page.locator('#player-title').textContent(), '재생할 음악을 선택하세요');
    assert.equal(await page.locator('#elapsed').textContent(), '0:00');
    assert.equal(await page.locator('#duration').textContent(), '0:00');
    assert.equal(await page.locator('audio').evaluate(element => element.paused && !element.hasAttribute('src') && element.currentTime === 0), true);
    assert.equal(await page.locator('#clear-queue').isDisabled(), true);
    assert.equal(await page.locator('.track-row').count(), 6);
    assert.equal(await page.evaluate(() => navigator.mediaSession.metadata), null);
    await page.locator('#search').fill('D');
    await page.locator('.track-row').dblclick();
    await page.waitForFunction(() => !document.querySelector('audio').paused);
    assert.equal(await page.locator('.queue-row').count(), 1);
    assert.equal(await page.locator('#clear-queue').isEnabled(), true);
    await page.locator('#clear-queue').click();
    assert.equal(await page.locator('.queue-row').count(), 0);
    assert.equal(await page.locator('audio').evaluate(element => element.paused && !element.hasAttribute('src')), true);
    await instance.close();
    const stored = JSON.parse(await fs.readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.deepEqual(stored.settings.queue, []);
    assert.equal(stored.settings.currentId, null);
    assert.equal(stored.settings.queueIndex, -1);
    assert.equal(stored.settings.position, 0);
    assert.equal(stored.tracks.length, 6);
    assert.deepEqual(errors, []);
  } finally {
    await instance.close().catch(() => {});
    assert.equal(path.dirname(temp).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('music-player-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
