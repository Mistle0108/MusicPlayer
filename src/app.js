const $ = selector => document.querySelector(selector);
const audio = $('#audio');
const icon = window.renderPlayerIcon;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
['minimize', 'maximize', 'close'].forEach(action => {
  $(`#${action}`).innerHTML = icon(action);
  $(`#${action}`).onclick = () => window.player.window(action);
});
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const time = value => { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
const cover = track => track?.artwork ? `<img src="${escapeHtml(track.artwork)}" alt="" draggable="false">` : icon('music');
const format = track => track ? `${track.format}${track.sampleRate ? ` · ${Number((track.sampleRate / 1000).toFixed(1))} kHz` : ''}` : '';
let tracks = [], playlists = [], favorites = [], queue = [], currentId = null;
let view = 'all', group = null, compact = false, shuffle = false, repeat = 'off', sort = 'added';
let compactQueueExpanded = false;
let queueIndex = -1;
let seekSeconds = 5;
let selectedTrackIds = new Set(), selectionAnchor = null;
let resumeTime = 0, importing = false, history = [], lastVolume = .7, saveTimer, toastTimer;
const trackById = id => tracks.find(track => track.id === id);
const currentTrack = () => trackById(currentId);

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').hidden = true, 3500);
}
function state() {
  return { playlists, favorites, settings: { currentId, queue, queueIndex, queueVersion: 2, position: audio.currentTime || resumeTime, volume: audio.volume, muted: audio.muted, shuffle, repeat, sort, output: audio.sinkId || 'default' } };
}
function save(immediate = false) {
  clearTimeout(saveTimer);
  if (immediate) return window.player.save(state()).catch(() => notify('설정을 저장하지 못했습니다. 저장 공간을 확인해주세요.'));
  saveTimer = setTimeout(() => save(true), 300);
}
const rangeSheet = new CSSStyleSheet();
const menuSheet = new CSSStyleSheet();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, rangeSheet, menuSheet];
function paintRanges() {
  rangeSheet.replaceSync(['seek', 'volume'].map(id => {
    const input = $(`#${id}`);
    return `#${id}{background:linear-gradient(to right,var(--blue) ${Number(input.value) / Number(input.max) * 100}%,var(--range-track) 0)}`;
  }).join('\n'));
}
function visibleTracks() {
  let result = tracks;
  if (view === 'favorites') result = result.filter(track => favorites.includes(track.id));
  if (view.startsWith('playlist:')) {
    const list = playlists.find(item => item.id === view.slice(9));
    result = (list?.trackIds || []).map(trackById).filter(Boolean);
  }
  if (group) result = result.filter(track => track[group.type] === group.value);
  const query = $('#search').value.trim().toLocaleLowerCase();
  if (query) result = result.filter(track => `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(query));
  return sort === 'order' ? [...result] : [...result].sort((a, b) => sort === 'added' ? b.addedAt - a.addedAt : a[sort].localeCompare(b[sort], 'ko'));
}
function setView(next, nextGroup = null) {
  selectedTrackIds.clear(); selectionAnchor = null;
  view = next; group = nextGroup; $('#search').value = ''; renderLibrary();
}
function renderTrackSelection() {
  document.querySelectorAll('.track-row').forEach(row => {
    const selected = !view.startsWith('playlist:') && selectedTrackIds.has(row.dataset.id);
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-pressed', String(selected));
  });
}
function selectTrack(id, event = {}) {
  const list = visibleTracks();
  const index = list.findIndex(track => track.id === id);
  const anchor = list.findIndex(track => track.id === selectionAnchor);
  if (event.shiftKey && anchor >= 0) {
    if (!event.ctrlKey && !event.metaKey) selectedTrackIds.clear();
    list.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).forEach(track => selectedTrackIds.add(track.id));
  } else if (event.ctrlKey || event.metaKey) {
    selectedTrackIds.has(id) ? selectedTrackIds.delete(id) : selectedTrackIds.add(id);
    selectionAnchor = id;
  } else {
    selectedTrackIds = new Set([id]); selectionAnchor = id;
  }
  renderTrackSelection();
}
const trackDragType = 'application/x-music-tracks';
const queueDragType = 'application/x-music-queue';
const playlistTrackDragType = 'application/x-music-playlist-track';
const playlistDragType = 'application/x-music-playlist';
function draggedTrackIds(event) {
  try {
    const ids = JSON.parse(event.dataTransfer.getData(trackDragType));
    return Array.isArray(ids) ? [...new Set(ids)].filter(trackById) : [];
  } catch { return []; }
}
function clearMusicDrag() {
  document.querySelectorAll('.music-dragging, .drop-tracks').forEach(element => element.classList.remove('music-dragging', 'drop-tracks'));
  $('#queue-drop-indicator').hidden = true;
  document.querySelectorAll('.track-row.drop-before, .track-row.drop-after').forEach(row => row.classList.remove('drop-before', 'drop-after'));
}
function queueInsertionIndex(event) {
  const list = $('#queue-list');
  if (event.clientY < list.getBoundingClientRect().top) return queue.length;
  const rows = [...list.querySelectorAll('.queue-row')];
  const index = rows.findIndex(row => {
    const bounds = row.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2;
  });
  return index < 0 ? queue.length : index;
}
function showQueueInsertion(index) {
  const panel = $('.queue-panel').getBoundingClientRect();
  const list = $('#queue-list').getBoundingClientRect();
  const rows = $('#queue-list').querySelectorAll('.queue-row');
  const y = rows[index]?.getBoundingClientRect().top ?? (rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : list.top);
  const indicator = $('#queue-drop-indicator');
  indicator.style.left = `${list.left - panel.left}px`;
  indicator.style.width = `${list.width}px`;
  indicator.style.top = `${Math.max(list.top + 2, Math.min(y, list.bottom - 2)) - panel.top - 2}px`;
  indicator.dataset.index = index;
  indicator.hidden = false;
}
function bindMusicDrag(element, ids, playlistEntry = null) {
  element.draggable = true;
  element.ondragstart = event => {
    event.stopPropagation();
    event.dataTransfer.setData(trackDragType, JSON.stringify(typeof ids === 'function' ? ids() : ids));
    if (playlistEntry) event.dataTransfer.setData(playlistTrackDragType, JSON.stringify(playlistEntry));
    event.dataTransfer.effectAllowed = playlistEntry ? 'copyMove' : 'copy';
    element.classList.add('music-dragging');
  };
  element.ondragend = clearMusicDrag;
}
function renderNavigation() {
  $('#library-count').textContent = tracks.length;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#favorites-view').classList.toggle('active', view === 'favorites');
  $('#playlist-navigation').innerHTML = playlists.map(list => `<div draggable="true" class="nav-item playlist-entry ${view === `playlist:${list.id}` ? 'active' : ''}" data-playlist="${list.id}"><button class="playlist-open" title="${escapeHtml(list.name)}"><span class="playlist-name">${escapeHtml(list.name)}</span></button><button class="playlist-play icon-button" aria-label="${escapeHtml(list.name)} 재생" title="플레이리스트 재생" ${list.trackIds.some(trackById) ? '' : 'disabled'}>${icon('play')}</button></div>`).join('');
  $('#playlist-navigation').querySelectorAll('.playlist-entry').forEach(button => {
    button.querySelector('.playlist-open').onclick = () => setView(`playlist:${button.dataset.playlist}`);
    button.querySelector('.playlist-play').onclick = () => {
      setView(`playlist:${button.dataset.playlist}`);
      const list = visibleTracks();
      if (list.length) playFromList(list[0].id, list);
    };
    button.ondragstart = event => {
      event.dataTransfer.setData(playlistDragType, button.dataset.playlist);
      event.dataTransfer.effectAllowed = 'copyMove';
      button.classList.add('dragging');
    };
    button.ondragend = () => {
      document.querySelectorAll('#playlist-navigation .playlist-entry').forEach(item => item.classList.remove('dragging', 'drop-before', 'drop-after'));
      clearMusicDrag();
    };
    button.ondragover = event => {
      if ([...event.dataTransfer.types].includes(trackDragType)) {
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
        button.classList.add('drop-tracks');
        return;
      }
      if (![...event.dataTransfer.types].includes(playlistDragType)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      const after = event.clientY > button.getBoundingClientRect().top + button.offsetHeight / 2;
      button.classList.toggle('drop-before', !after); button.classList.toggle('drop-after', after);
    };
    button.ondragleave = event => { if (!button.contains(event.relatedTarget)) button.classList.remove('drop-before', 'drop-after', 'drop-tracks'); };
    button.ondrop = event => {
      if ([...event.dataTransfer.types].includes(trackDragType)) {
        event.preventDefault(); event.stopPropagation(); clearMusicDrag();
        const list = playlists.find(item => item.id === button.dataset.playlist);
        if (!list) return;
        const incoming = draggedTrackIds(event).filter(id => !list.trackIds.includes(id));
        if (!incoming.length) { notify('이미 이 플레이리스트에 있는 음악이에요'); return; }
        list.trackIds.push(...incoming);
        renderLibrary(); save();
        notify(`${list.name}에 ${incoming.length}곡을 추가했어요`);
        return;
      }
      const id = event.dataTransfer.getData(playlistDragType);
      if (!id) return;
      event.preventDefault(); event.stopPropagation();
      const from = playlists.findIndex(list => list.id === id);
      if (from < 0 || id === button.dataset.playlist) { button.classList.remove('drop-before', 'drop-after'); return; }
      const after = event.clientY > button.getBoundingClientRect().top + button.offsetHeight / 2;
      const [list] = playlists.splice(from, 1);
      const target = playlists.findIndex(item => item.id === button.dataset.playlist);
      playlists.splice(target + (after ? 1 : 0), 0, list);
      renderNavigation(); save();
    };
  });
}
function renderLibrary() {
  renderNavigation();
  const list = visibleTracks();
  const visibleIds = new Set(list.map(track => track.id));
  selectedTrackIds = new Set([...selectedTrackIds].filter(id => visibleIds.has(id)));
  if (!visibleIds.has(selectionAnchor)) selectionAnchor = null;
  const playlist = playlists.find(item => `playlist:${item.id}` === view);
  $('#view-title').textContent = group?.value || playlist?.name || ({ all: '모든 음악', albums: '앨범', artists: '아티스트', favorites: '즐겨찾기' }[view] || '모든 음악');
  $('#view-title').title = $('#view-title').textContent;
  $('#view-subtitle').textContent = `${list.length}곡${!tracks.length ? ' · 나만의 음악을 모아보세요' : ` · ${time(list.reduce((sum, track) => sum + track.duration, 0))}`}`;
  $('#playlist-actions').hidden = !playlist;
  $('#add-files-label').textContent = playlist ? '플리에 추가' : '파일 추가';
  $('#empty-add').lastChild.textContent = playlist ? '플리에 음악 추가' : '음악 추가하기';
  const groups = new Map();
  const key = view === 'artists' && !group ? 'artist' : 'album';
  for (const track of list) {
    if (!groups.has(track[key])) groups.set(track[key], track);
  }
  const cards = [...groups.values()];
  const stripVisible = list.length > 0 && !group && (view === 'all' || view === 'albums' || view === 'artists');
  $('#album-strip').hidden = !stripVisible;
  $('#album-strip').innerHTML = (view === 'all' ? cards.slice(0, 4) : cards).map(track => `<button class="album-card" data-group="${escapeHtml(track[key])}" title="${escapeHtml(track[key])}"><div class="cover album-art">${cover(track)}</div><strong>${escapeHtml(track[key])}</strong><small>${escapeHtml(key === 'artist' ? `${list.filter(item => item.artist === track.artist).length}곡` : track.artist)}</small></button>`).join('');
  $('#album-strip').querySelectorAll('button').forEach(button => {
    button.onclick = () => setView(view, { type: key, value: button.dataset.group });
    button.title = `${button.dataset.group} · 드래그하여 플레이리스트에 추가`;
    bindMusicDrag(button, tracks.filter(track => track[key] === button.dataset.group).map(track => track.id));
  });
  $('#track-table').hidden = !list.length;
  $('#list-toolbar').hidden = !list.length;
  $('#list-label').textContent = $('#search').value ? '검색 결과' : '전체 곡';
  $('#empty-state').hidden = Boolean(list.length);
  $('#empty-state h2').textContent = !tracks.length ? '좋아하는 음악으로 채워보세요' : $('#search').value ? '검색 결과가 없어요' : '아직 음악이 없어요';
  $('#empty-state p').textContent = !tracks.length ? '음악 파일이나 폴더를 추가하면 이곳에서 모든 음악을 한눈에 볼 수 있어요.' : $('#search').value ? '다른 제목, 아티스트 또는 앨범으로 검색해보세요.' : view === 'favorites' ? '곡 옆 하트를 눌러 좋아하는 음악을 모아보세요.' : '곡을 왼쪽 플레이리스트에 드래그하여 추가하세요.';
  $('#empty-add').hidden = Boolean(tracks.length) && !playlist;
  if (playlist) $('#empty-state p').textContent = '파일이나 폴더를 추가하면 이 플레이리스트와 모든 음악에 함께 등록돼요.';
  $('.supported').hidden = Boolean(tracks.length);
  $('#tracks').innerHTML = list.map((track, index) => `<div class="track-row ${track.id === currentId ? 'current' : ''}" data-id="${track.id}" tabindex="0" role="button" aria-label="${escapeHtml(track.title)} 재생"><span class="row-number">${track.id === currentId ? icon(audio.paused ? 'play' : 'pause') : index + 1}</span><span class="row-main"><span class="cover row-art">${cover(track)}</span><span class="row-text"><span class="row-title">${escapeHtml(track.title)}</span><span class="row-format">${escapeHtml(format(track))}</span></span></span><span class="cell-text">${escapeHtml(track.artist)}</span><span class="cell-text">${escapeHtml(track.album)}</span><span class="row-time">${time(track.duration)}</span><button class="row-menu" aria-label="${escapeHtml(track.title)} 더 보기" title="더 보기">${icon('more')}</button></div>`).join('');
  $('#tracks').querySelectorAll('.track-row').forEach((row, index) => {
    if (playlist || ['all', 'albums', 'artists', 'favorites'].includes(view)) {
      row.title = playlist ? '두 번 클릭하여 재생 · 드래그하여 순서 변경 또는 재생 목록에 추가' : '두 번 클릭하여 재생 · 드래그하여 플레이리스트 또는 재생 목록에 추가';
      bindMusicDrag(row, playlist ? [row.dataset.id] : () => {
        if (!selectedTrackIds.has(row.dataset.id)) selectTrack(row.dataset.id);
        return visibleTracks().filter(track => selectedTrackIds.has(track.id)).map(track => track.id);
      }, playlist ? { playlistId: playlist.id, index } : null);
    }
    if (playlist) {
      row.ondragover = event => {
        if (![...event.dataTransfer.types].includes(playlistTrackDragType)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        document.querySelectorAll('.track-row.drop-before, .track-row.drop-after').forEach(item => item.classList.remove('drop-before', 'drop-after'));
        row.classList.add(after ? 'drop-after' : 'drop-before');
      };
      row.ondragleave = event => { if (!row.contains(event.relatedTarget)) row.classList.remove('drop-before', 'drop-after'); };
      row.ondrop = event => {
        if (![...event.dataTransfer.types].includes(playlistTrackDragType)) return;
        event.preventDefault(); event.stopPropagation(); clearMusicDrag();
        let source;
        try { source = JSON.parse(event.dataTransfer.getData(playlistTrackDragType)); } catch { return; }
        if (source.playlistId !== playlist.id || !Number.isInteger(source.index) || !list[source.index]) return;
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        let target = index + (after ? 1 : 0);
        if (target > source.index) target--;
        if (target === source.index) return;
        // Replace only visible entries so searches preserve hidden songs and duplicate occurrences.
        const used = new Set();
        const slots = list.map(track => {
          const position = playlist.trackIds.findIndex((id, position) => id === track.id && !used.has(position));
          used.add(position);
          return position;
        }).sort((a, b) => a - b);
        const reordered = list.map(track => track.id);
        const [moved] = reordered.splice(source.index, 1);
        reordered.splice(target, 0, moved);
        slots.forEach((position, index) => { playlist.trackIds[position] = reordered[index]; });
        sort = 'order'; $('#sort').value = sort;
        renderLibrary(); save();
      };
    }
    const playRow = () => playFromList(row.dataset.id, playlist ? list : [list[index]], playlist ? index : 0);
    row.onclick = event => { if (!playlist && !event.target.closest('button')) selectTrack(row.dataset.id, event); };
    row.ondblclick = event => { if (!event.target.closest('button')) playRow(); };
    row.onkeydown = event => {
      if (event.target !== row) return;
      if (event.key === 'Enter') playRow();
    };
    const contextTracks = () => {
      if (playlist) return [list[index]];
      if (!selectedTrackIds.has(row.dataset.id)) selectTrack(row.dataset.id);
      return visibleTracks().filter(track => selectedTrackIds.has(track.id));
    };
    row.querySelector('button').onclick = event => { event.stopPropagation(); openMenu(contextTracks(), event.currentTarget); };
    row.oncontextmenu = event => { event.preventDefault(); openMenu(contextTracks(), row.querySelector('button'), { x: event.clientX, y: event.clientY }); };
  });
  renderTrackSelection();
}
function renderQueue() {
  const track = currentTrack();
  $('#queue-count').textContent = `${queue.length}곡`;
  $('#compact-queue-count').textContent = `${queue.length}곡`;
  $('#clear-queue').disabled = !queue.length && !track;
  $('#save-queue').disabled = !queue.length;
  $('#queue-current').innerHTML = track ? `<div class="cover queue-art">${cover(track)}</div><div class="queue-meta"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span><span>${escapeHtml(track.album)}</span><small>${escapeHtml(format(track))} · ${time(track.duration)}</small></div>` : '<div class="queue-empty">재생 중인 음악이 없습니다</div>';
  $('#queue-list').innerHTML = queue.length ? queue.map((id, index) => {
    const item = trackById(id);
    return `<div class="queue-row ${index === queueIndex ? 'current' : ''}" draggable="true" data-index="${index}" aria-current="${index === queueIndex}" title="두 번 클릭하여 재생 · 드래그하여 순서 변경"><span class="queue-order">${index + 1}</span><div class="cover">${cover(item)}</div><div class="queue-meta"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.artist)}</span></div><span class="queue-time">${time(item.duration)}</span><button class="queue-remove" title="${index === queueIndex ? '재생 중인 곡' : '재생 목록에서 제거'}" aria-label="재생 목록에서 제거" ${index === queueIndex ? 'disabled' : ''}>${icon('close')}</button></div>`;
  }).join('') : '<div class="queue-empty">다음에 들을 음악을 추가해보세요</div>';
  $('#queue-list').querySelectorAll('.queue-row').forEach(row => {
    row.ondblclick = event => { if (!event.target.closest('button')) playQueue(Number(row.dataset.index)); };
    row.querySelector('button').onclick = () => {
      const index = Number(row.dataset.index);
      if (index === queueIndex) return;
      queue.splice(index, 1);
      if (index < queueIndex) queueIndex--;
      history = history.filter(item => item !== index).map(item => item > index ? item - 1 : item);
      renderQueue(); save();
    };
    row.ondragstart = event => {
      event.dataTransfer.setData(queueDragType, row.dataset.index);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    };
    row.ondragend = () => { row.classList.remove('dragging'); clearMusicDrag(); };
  });
  $('.queue-row.current')?.scrollIntoView({ block: 'nearest' });
}
function renderPlayer() {
  const track = currentTrack();
  $('#player-art').innerHTML = cover(track);
  $('#player-title').textContent = track?.title || '재생할 음악을 선택하세요';
  $('#player-artist').textContent = track ? `${track.artist} · ${track.album}` : '음악 파일을 추가해 시작하세요';
  $('#player-format').textContent = format(track);
  $('#favorite').disabled = !track;
  $('#favorite').classList.toggle('active', favorites.includes(currentId));
  $('#favorite').setAttribute('aria-pressed', String(favorites.includes(currentId)));
  $('#play').innerHTML = icon(audio.paused ? 'play' : 'pause');
  $('#play').title = audio.paused ? '재생' : '일시정지';
  $('#play').setAttribute('aria-label', $('#play').title);
  $('#play').disabled = !tracks.length;
  $('#previous').disabled = !track;
  $('#next').disabled = !track;
  $('#seek').disabled = !track;
  $('#shuffle').classList.toggle('active', shuffle);
  $('#shuffle').setAttribute('aria-pressed', String(shuffle));
  $('#repeat').innerHTML = icon(repeat === 'one' ? 'repeatOne' : 'repeat');
  $('#repeat').classList.toggle('active', repeat !== 'off');
  $('#repeat').title = ({ off: '반복 끔', all: '전체 반복', one: '한 곡 반복' })[repeat];
  $('#repeat').setAttribute('aria-label', $('#repeat').title);
  $('#mute').innerHTML = icon(audio.muted || !audio.volume ? 'muted' : 'volume');
  $('#mute').title = audio.muted ? '음소거 해제' : '음소거';
  $('#volume').value = audio.muted ? 0 : Math.round(audio.volume * 100);
  updateTime();
}
function updateTime() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack()?.duration || 0;
  $('#elapsed').textContent = time(audio.currentTime || resumeTime);
  $('#duration').textContent = time(duration);
  $('#seek').value = duration ? (audio.currentTime || resumeTime) / duration * 1000 : 0;
  paintRanges();
}
function render() { renderLibrary(); renderQueue(); renderPlayer(); }

function stopPlayback() {
  currentId = null; resumeTime = 0;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
}
async function removeLibraryTracks(ids) {
  try {
    await save(true);
    const imported = await window.player.removeTracks(ids);
    const removed = new Set(ids);
    const entries = queue.map((id, index) => ({ id, index })).filter(entry => !removed.has(entry.id));
    const indexMap = new Map(entries.map((entry, index) => [entry.index, index]));
    queue = entries.map(entry => entry.id);
    queueIndex = indexMap.get(queueIndex) ?? -1;
    history = history.filter(index => indexMap.has(index)).map(index => indexMap.get(index));
    if (removed.has(currentId)) stopPlayback();
    tracks = imported;
    favorites = favorites.filter(id => !removed.has(id));
    playlists.forEach(list => list.trackIds = list.trackIds.filter(id => !removed.has(id)));
    ids.forEach(id => selectedTrackIds.delete(id));
    render(); await save(true);
    notify(`${ids.length}곡을 라이브러리에서 삭제했어요`);
  } catch { notify('라이브러리에서 삭제하지 못했습니다. 다시 시도해주세요.'); }
}

async function playTrack(id, autoplay = true) {
  const track = trackById(id);
  if (!track) return;
  currentId = id; resumeTime = 0;
  audio.src = track.url;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: track.artwork ? [{ src: track.artwork }] : [] });
  render(); save();
  if (autoplay) {
    try { await audio.play(); }
    catch (error) { if (error.name !== 'AbortError') notify('이 곡을 재생할 수 없습니다. 파일 위치와 지원 형식을 확인해주세요.'); }
  }
}
function playFromList(id, list, index = list.findIndex(track => track.id === id)) {
  history = [];
  queue = list.map(track => track.id);
  playQueue(index, true, false);
}
function playQueue(index, autoplay = true, remember = true) {
  if (!queue[index]) return;
  if (remember && queueIndex >= 0 && index !== queueIndex) history.push(queueIndex);
  queueIndex = index;
  return playTrack(queue[index], autoplay);
}
async function togglePlay() {
  if (!currentId) { if (queue.length) playQueue(0); else { const list = visibleTracks(); if (list.length) playFromList(list[0].id, list); } return; }
  if (audio.paused) {
    try { await audio.play(); } catch { notify('음악 파일을 재생할 수 없습니다. 파일 위치와 형식을 확인해주세요.'); }
  } else audio.pause();
}
function nextTrack(ended = false) {
  if (ended && repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => notify('음악을 재생하지 못했습니다.')); return; }
  if (!queue.length) return;
  if (ended && !shuffle && queueIndex === queue.length - 1 && repeat === 'off') { save(); return; }
  let choices = queue.map((_, index) => index).filter(index => index !== queueIndex && !history.includes(index));
  if (shuffle && !choices.length) {
    if (ended && repeat === 'off') { save(); return; }
    history = [];
    choices = queue.map((_, index) => index).filter(index => index !== queueIndex);
  }
  const index = shuffle && choices.length ? choices[Math.floor(Math.random() * choices.length)] : (queueIndex + 1) % queue.length;
  playQueue(index);
}
function previousTrack() {
  if (!queue.length) return;
  const index = history.length ? history.pop() : (queueIndex - 1 + queue.length) % queue.length;
  playQueue(index, true, false);
}
function toggleFavorite(id = currentId) {
  if (!id) return;
  favorites = favorites.includes(id) ? favorites.filter(value => value !== id) : [...favorites, id];
  render(); save();
}

function openMenu(items, anchor, pointer = null) {
  const menu = $('#track-menu');
  $('#toast').hidden = true;
  const ids = items.map(track => track.id);
  const track = items[0];
  const playlist = playlists.find(item => `playlist:${item.id}` === view);
  const allFavorites = ids.every(id => favorites.includes(id));
  const actions = [
    ['지금 재생', () => playFromList(track.id, playlist ? visibleTracks() : items)],
    ['바로 다음에 재생', () => { queue.splice(queueIndex + 1, 0, ...ids); history = history.map(index => index > queueIndex ? index + ids.length : index); renderQueue(); save(); notify('바로 다음 곡으로 추가했어요'); }],
    ['재생 목록 맨 뒤에 추가', () => { queue.push(...ids); renderQueue(); save(); notify('재생 목록에 추가했어요'); }],
    [allFavorites ? '즐겨찾기 해제' : '즐겨찾기 추가', () => { favorites = allFavorites ? favorites.filter(id => !ids.includes(id)) : [...new Set([...favorites, ...ids])]; render(); save(); }],
    ['파일 위치 열기', () => { items.forEach(item => window.player.showFile(item.id)); }]
  ];
  if (playlist) actions.push(['이 플레이리스트에서 제거', () => { playlist.trackIds = playlist.trackIds.filter(id => id !== track.id); renderLibrary(); save(); }]);
  else actions.push(['라이브러리에서 삭제', () => removeLibraryTracks(ids)]);
  menu.replaceChildren();
  if (items.length > 1) {
    const label = document.createElement('div'); label.className = 'menu-label'; label.textContent = `${items.length}곡 선택`; menu.append(label);
  }
  const addAction = (label, action) => {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => { menu.hidden = true; action(); }; menu.append(button);
  };
  actions.forEach(([label, action]) => addAction(label, action));
  menu.hidden = false;
  const bounds = anchor.getBoundingClientRect();
  menuSheet.replaceSync(`#track-menu{left:${Math.max(5, Math.min(pointer?.x ?? bounds.right - 200, innerWidth - 215))}px;top:${Math.max(45, Math.min(pointer?.y ?? bounds.bottom, innerHeight - menu.offsetHeight - 10))}px}`);
}
async function askName(title, initial = '') {
  $('#dialog-title').textContent = title; $('#name-input').value = initial;
  $('#name-input').setCustomValidity('');
  const dialog = $('#name-dialog'); dialog.showModal(); $('#name-input').focus();
  dialog.returnValue = '';
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'save' ? $('#name-input').value.trim() : ''), { once: true }); });
}
async function createPlaylist(initialTrackIds = []) {
  const name = await askName(initialTrackIds.length ? '재생 목록을 플레이리스트로 저장' : '플레이리스트 만들기');
  if (!name) return null;
  const list = { id: crypto.randomUUID(), name, trackIds: initialTrackIds.filter(trackById) };
  playlists.push(list); renderNavigation(); save(); return list;
}
async function importMusic(folder = false, files = null) {
  if (importing) return;
  const targetPlaylist = playlists.find(list => `playlist:${list.id}` === view);
  importing = true;
  [$('#add-files'), $('#add-folder'), $('#empty-add')].forEach(button => button.disabled = true);
  try {
    let recursive = true;
    if (folder && !files) {
      const dialog = $('#folder-dialog');
      dialog.returnValue = '';
      dialog.showModal();
      const selected = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'select'), { once: true }));
      if (!selected) return;
      recursive = $('#folder-dialog input:checked').value === 'recursive';
    }
    if (files) notify('음악 정보를 읽고 있어요…');
    const result = files ? await window.player.importDrop(files) : await window.player.choose(folder, recursive);
    if (result) {
      tracks = result.tracks;
      let playlistAdded = 0;
      if (targetPlaylist && playlists.includes(targetPlaylist)) {
        const incoming = (result.selectedIds || []).filter(id => !targetPlaylist.trackIds.includes(id));
        targetPlaylist.trackIds.push(...incoming);
        playlistAdded = incoming.length;
        await save(true);
      }
      render();
      const addedMessage = targetPlaylist ? `${playlistAdded}곡을 플레이리스트에 추가했어요${result.added ? ` · 새 음악 ${result.added}곡 등록` : ''}` : `${result.added}곡을 추가했어요`;
      notify(result.added || playlistAdded ? `${addedMessage}${result.unreadable ? ` · ${result.unreadable}개 파일을 읽지 못했어요` : ''}` : result.unreadable ? '파일 정보를 읽지 못했어요. 지원하는 음악 파일인지 확인해주세요.' : '추가할 새 음악이 없어요. 이미 등록된 파일은 건너뜁니다.');
    }
  } catch { notify('음악을 추가하지 못했습니다. 파일과 폴더를 확인해주세요.'); }
  finally { importing = false; [$('#add-files'), $('#add-folder'), $('#empty-add')].forEach(button => button.disabled = false); }
}
function updateMode(value) {
  $('#track-menu').hidden = true;
  compact = value; document.body.classList.toggle('compact', compact);
  $('#mode-toggle').innerHTML = icon(compact ? 'expand' : 'compact');
  $('#mode-toggle').title = compact ? '기본 모드로 전환' : '축약 모드로 전환';
  $('#mode-toggle').setAttribute('aria-label', $('#mode-toggle').title);
}
function updateQueueExpanded(value) {
  compactQueueExpanded = Boolean(value);
  document.body.classList.toggle('queue-expanded', compactQueueExpanded);
  $('#compact-queue-toggle').setAttribute('aria-expanded', String(compactQueueExpanded));
  $('#compact-queue-chevron').innerHTML = icon(compactQueueExpanded ? 'chevronUp' : 'chevronDown');
  if (compact && compactQueueExpanded) $('.queue-row.current')?.scrollIntoView({ block: 'nearest' });
}
window.player.onMode(updateMode);
window.player.onQueueExpanded(updateQueueExpanded);
$('#compact-queue-toggle').onclick = async () => updateQueueExpanded(await window.player.expandQueue(!compactQueueExpanded));
function applyPreferences(preferences = {}) {
  Appearance.apply(preferences.appearance);
  seekSeconds = preferences.seekSeconds ?? 5;
}
window.player.onPreferences(applyPreferences);
window.player.onClose(async () => { await save(true); window.player.closeReady(); });
$('#open-settings').onclick = () => window.player.openSettings();
$('#open-youtube').onclick = () => window.player.openYouTube();
window.player.onLibraryImported(imported => { tracks = imported; render(); });
$('#cancel-name').onclick = () => $('#name-dialog').close('cancel');
$('#name-dialog form').onsubmit = event => {
  event.preventDefault();
  if (!$('#name-input').value.trim()) { $('#name-input').setCustomValidity('플레이리스트 이름을 입력해주세요.'); $('#name-input').reportValidity(); return; }
  $('#name-dialog').close('save');
};
$('#name-input').oninput = () => $('#name-input').setCustomValidity('');
$('#name-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
});
$('#mode-toggle').onclick = async () => updateMode(await window.player.mode(!compact));
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
$('#favorites-view').onclick = () => setView('favorites');
$('#new-playlist').onclick = async () => { const list = await createPlaylist(); if (list) setView(`playlist:${list.id}`); };
$('#save-queue').onclick = async () => {
  if (!queue.length) return;
  const list = await createPlaylist([...queue]);
  if (list) {
    sort = 'order'; $('#sort').value = sort;
    setView(`playlist:${list.id}`);
    await save(true);
    notify(`${list.name}에 재생 목록 ${list.trackIds.length}곡을 저장했어요`);
  }
};
$('.queue-panel').ondragover = event => {
  const types = [...event.dataTransfer.types];
  if (!types.includes(trackDragType) && !types.includes(queueDragType) && !types.includes(playlistDragType)) return;
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = types.includes(queueDragType) ? 'move' : 'copy';
  $('.queue-panel').classList.add('drop-tracks');
  showQueueInsertion(queueInsertionIndex(event));
};
$('.queue-panel').ondragleave = event => {
  const bounds = $('.queue-panel').getBoundingClientRect();
  if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) {
    $('.queue-panel').classList.remove('drop-tracks');
    $('#queue-drop-indicator').hidden = true;
  }
};
$('.queue-panel').ondrop = event => {
  const types = [...event.dataTransfer.types];
  if (!types.includes(trackDragType) && !types.includes(queueDragType) && !types.includes(playlistDragType)) return;
  event.preventDefault(); event.stopPropagation();
  const index = queueInsertionIndex(event);
  clearMusicDrag();
  if (types.includes(queueDragType)) {
    const from = Number(event.dataTransfer.getData(queueDragType));
    if (!Number.isInteger(from) || from < 0 || from >= queue.length) return;
    const indices = queue.map((_, position) => position);
    const [moved] = indices.splice(from, 1);
    indices.splice(index > from ? index - 1 : index, 0, moved);
    queue = indices.map(position => queue[position]);
    queueIndex = indices.indexOf(queueIndex);
    history = history.map(position => indices.indexOf(position));
    renderQueue(); save();
    return;
  }
  const playlist = types.includes(playlistDragType) ? playlists.find(list => list.id === event.dataTransfer.getData(playlistDragType)) : null;
  const ids = playlist ? playlist.trackIds.filter(trackById) : draggedTrackIds(event);
  if (!ids.length) return;
  queue.splice(index, 0, ...ids);
  if (queueIndex >= index) queueIndex += ids.length;
  history = history.map(previous => previous >= index ? previous + ids.length : previous);
  renderQueue(); save();
  notify(`재생 목록에 ${ids.length}곡을 추가했어요`);
};
$('#rename-playlist').onclick = async () => {
  const list = playlists.find(item => `playlist:${item.id}` === view); if (!list) return;
  const name = await askName('플레이리스트 이름 변경', list.name); if (name) { list.name = name; renderLibrary(); save(); }
};
$('#delete-playlist').onclick = () => {
  const id = view.slice(9); const dialog = $('#confirm-dialog'); dialog.showModal();
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'delete') { playlists = playlists.filter(list => list.id !== id); setView('all'); save(); } }, { once: true });
};
$('#add-files').onclick = () => importMusic();
$('#add-folder').onclick = () => importMusic(true);
$('#cancel-folder').onclick = () => $('#folder-dialog').close('cancel');
$('#empty-add').onclick = () => importMusic();
$('#search').oninput = renderLibrary;
$('#sort').onchange = () => { sort = $('#sort').value; renderLibrary(); save(); };
$('#favorite').onclick = () => toggleFavorite();
$('#play').onclick = togglePlay;
$('#next').onclick = () => nextTrack();
$('#previous').onclick = previousTrack;
$('#shuffle').onclick = () => { shuffle = !shuffle; renderPlayer(); save(); };
$('#repeat').onclick = () => { repeat = ({ off: 'all', all: 'one', one: 'off' })[repeat]; renderPlayer(); save(); };
$('#clear-queue').onclick = () => {
  queue = []; queueIndex = -1; history = []; stopPlayback();
  render(); save();
};
$('#seek').oninput = () => {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (duration) { audio.currentTime = Number($('#seek').value) / 1000 * duration; resumeTime = 0; updateTime(); save(); }
};
$('#volume').oninput = () => { audio.volume = Number($('#volume').value) / 100; audio.muted = false; if (audio.volume) lastVolume = audio.volume; renderPlayer(); save(); };
$('#mute').onclick = () => { if (!audio.volume) audio.volume = lastVolume; audio.muted = !audio.muted; renderPlayer(); save(); };
audio.onloadedmetadata = () => { if (resumeTime) { audio.currentTime = Math.min(resumeTime, audio.duration || resumeTime); resumeTime = 0; } updateTime(); };
audio.ontimeupdate = updateTime;
audio.onplay = () => { renderPlayer(); renderLibrary(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; save(); };
audio.onpause = () => { renderPlayer(); renderLibrary(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = currentTrack() ? 'paused' : 'none'; save(); };
audio.onended = () => nextTrack(true);
audio.onerror = () => { notify('이 파일을 재생할 수 없습니다. 파일이 이동되었거나 지원하지 않는 형식입니다.'); renderPlayer(); };
document.addEventListener('click', event => { if (!event.target.closest('.row-menu, #track-menu')) $('#track-menu').hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('#track-menu').hidden = true; $('#drop-overlay').hidden = true; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !compact && !view.startsWith('playlist:') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !document.querySelector('dialog[open]')) {
    event.preventDefault(); selectedTrackIds = new Set(visibleTracks().map(track => track.id)); renderTrackSelection();
  }
  if (event.defaultPrevented || event.isComposing || event.target.isContentEditable || event.target.closest('textarea, select, [role="textbox"]') || document.querySelector('dialog[open]') || !$('#track-menu').hidden) return;
  const range = event.target.matches('#seek, #volume');
  if (event.target.closest('input') && !range) return;
  if (event.altKey || event.metaKey || event.shiftKey) return;
  if (event.ctrlKey) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) { if (event.key === 'ArrowLeft') previousTrack(); else nextTrack(); }
    return;
  }
  let action;
  if (event.code === 'Space') {
    if (event.target.closest('button') && !event.target.closest('.player-bar')) return;
    action = togglePlay;
  } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    action = () => {
      if (!currentTrack() || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration, (audio.currentTime || resumeTime) + (event.key === 'ArrowRight' ? seekSeconds : -seekSeconds)));
      resumeTime = 0; updateTime(); save();
    };
  } else if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
    action = () => {
      audio.volume = Math.max(0, Math.min(1, Math.round((audio.volume + (event.key === 'ArrowUp' ? .05 : -.05)) * 100) / 100));
      audio.muted = false; if (audio.volume) lastVolume = audio.volume;
      renderPlayer(); save();
    };
  } else {
    const button = ({ m: '#mute', s: '#shuffle', r: '#repeat' })[event.key.toLowerCase()];
    if (button) action = () => $(button).click();
  }
  if (!action) return;
  event.preventDefault();
  if (!event.repeat || event.key.startsWith('Arrow')) action();
});
let dragDepth = 0;
document.addEventListener('dragenter', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; } });
document.addEventListener('dragover', event => { event.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; if (event.dataTransfer.files.length) importMusic(false, [...event.dataTransfer.files]); });
window.addEventListener('beforeunload', () => save(true));
setInterval(() => { if (!audio.paused) save(); }, 5000);
if ('mediaSession' in navigator) {
  for (const [action, handler] of Object.entries({ play: togglePlay, pause: () => audio.pause(), previoustrack: previousTrack, nexttrack: () => nextTrack(), seekbackward: () => audio.currentTime = Math.max(0, audio.currentTime - 10), seekforward: () => audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10), seekto: details => audio.currentTime = details.seekTime })) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported media keys are omitted by Chromium. */ }
  }
}
async function refreshOutputs() {
  if (!audio.setSinkId) { $('#output-device').hidden = true; return; }
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audiooutput');
    $('#output-device').replaceChildren();
    const defaultOption = new Option('기본 출력 장치', 'default'); $('#output-device').add(defaultOption);
    devices.filter(device => device.deviceId && device.deviceId !== 'default').forEach((device, index) => $('#output-device').add(new Option(device.label || `출력 장치 ${index + 1}`, device.deviceId)));
    $('#output-device').value = audio.sinkId || 'default';
  } catch { $('#output-device').hidden = true; }
}
$('#output-device').onchange = async () => {
  try { await audio.setSinkId($('#output-device').value); save(); }
  catch { notify('출력 장치를 변경하지 못했습니다.'); $('#output-device').value = audio.sinkId || 'default'; }
};
navigator.mediaDevices?.addEventListener('devicechange', refreshOutputs);

async function init() {
  try {
    const saved = await window.player.load();
    applyPreferences(saved.preferences);
    tracks = saved.tracks; playlists = saved.playlists; favorites = saved.favorites;
    const settings = saved.settings || {};
    if (settings.queueVersion === 2) {
      queue = (settings.queue || []).filter(trackById);
      queueIndex = queue[settings.queueIndex] === settings.currentId ? settings.queueIndex : queue.indexOf(settings.currentId);
    } else {
      // Restore the full list from older versions and discard duplicates caused by previous-track navigation.
      queue = [...new Set([...(settings.playbackOrder || []), ...(settings.queue || []), settings.currentId].filter(trackById))];
      queueIndex = queue.indexOf(settings.currentId);
    }
    shuffle = Boolean(settings.shuffle); repeat = ['off', 'all', 'one'].includes(settings.repeat) ? settings.repeat : 'off';
    sort = ['added', 'title', 'artist', 'album', 'order'].includes(settings.sort) ? settings.sort : 'added'; $('#sort').value = sort;
    audio.volume = typeof settings.volume === 'number' ? Math.max(0, Math.min(1, settings.volume)) : .7;
    audio.muted = Boolean(settings.muted); lastVolume = audio.volume || .7;
    if (trackById(settings.currentId)) {
      await playTrack(settings.currentId, false);
      resumeTime = settings.position || 0;
      if (audio.readyState >= 1 && resumeTime) { audio.currentTime = Math.min(resumeTime, audio.duration || resumeTime); resumeTime = 0; }
    }
    if (settings.output && audio.setSinkId) { try { await audio.setSinkId(settings.output); } catch { /* A disconnected device falls back to the default output. */ } }
    updateMode(false); render(); await refreshOutputs();
  } catch { notify('라이브러리를 불러오지 못했습니다. 앱을 다시 실행해주세요.'); }
}
init();
