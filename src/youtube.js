const $ = selector => document.querySelector(selector);
document.querySelectorAll('[data-icon]').forEach(element => element.innerHTML = window.renderPlayerIcon(element.dataset.icon));
let busy = false, ready = false;
const status = (message, error = false) => { $('#youtube-status').textContent = message; $('#youtube-status').classList.toggle('error', error); };
function controls() {
  for (const id of ['youtube-url', 'youtube-path', 'youtube-auto-save', 'choose-youtube-folder', 'open-youtube-folder', 'extract-youtube']) $(`#${id}`).disabled = busy;
  $('#save-youtube').disabled = busy || !ready;
}
function options() { return { folder: $('#youtube-path').value.trim(), autoSave: $('#youtube-auto-save').checked }; }
async function remember() { await window.player.youtubeOptions(options()); }
async function saveExtracted() {
  const response = await window.player.youtubeSave($('#youtube-path').value.trim());
  if (response.error) { status(response.error, true); return false; }
  status(`저장하고 라이브러리에 추가했어요. ${response.file}`);
  return true;
}
$('#close-youtube').onclick = () => window.player.window('close');
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.player.window('close'); });
$('#youtube-path').onchange = remember;
$('#youtube-auto-save').onchange = remember;
$('#choose-youtube-folder').onclick = async () => {
  const folder = await window.player.youtubeFolder($('#youtube-path').value.trim());
  if (folder) { $('#youtube-path').value = folder; await remember(); }
};
window.player.onYouTubeProgress(message => status(message));
$('#open-youtube-folder').onclick = async () => {
  try {
    const response = await window.player.youtubeOpenFolder($('#youtube-path').value.trim());
    if (response.error) status(response.error, true);
  } catch { status('폴더를 열지 못했습니다. 저장 경로를 확인해주세요.', true); }
};
window.player.onPreferences(preferences => Appearance.apply(preferences.appearance));
$('#youtube-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  if ($('#youtube-auto-save').checked && !$('#youtube-path').value.trim()) { status('저장할 폴더 경로를 입력해주세요.', true); return; }
  busy = true; ready = false; controls(); status('추출 준비 중…');
  try {
    await remember();
    const response = await window.player.youtubeExtract($('#youtube-url').value);
    if (response.error) { status(response.error, true); return; }
    ready = true;
    if ($('#youtube-auto-save').checked) await saveExtracted();
    else status(`${response.result.title} · 추출 완료. 저장 버튼을 눌러주세요.`);
  } catch { status('추출 중 문제가 발생했습니다. 다시 시도해주세요.', true); }
  finally { busy = false; controls(); }
};
$('#save-youtube').onclick = async () => {
  if (busy || !ready) return;
  busy = true; controls(); status('저장 중…');
  try { await remember(); await saveExtracted(); }
  catch { status('저장하지 못했습니다. 경로와 여유 공간을 확인해주세요.', true); }
  finally { busy = false; controls(); }
};
(async () => {
  const [preferences, state] = await Promise.all([window.player.preferences(), window.player.youtubeState()]);
  Appearance.apply(preferences.appearance);
  $('#youtube-path').value = state.folder;
  $('#youtube-auto-save').checked = state.autoSave;
  ready = Boolean(state.ready);
  if (ready) status(`${state.ready.title} · 저장할 수 있어요.`);
  controls(); $('#youtube-url').focus();
})().catch(() => status('설정을 불러오지 못했습니다.', true));
