const $ = selector => document.querySelector(selector);
document.querySelectorAll('[data-icon]').forEach(element => element.innerHTML = window.renderPlayerIcon(element.dataset.icon));
let preferences = { closeToTray: false, appearance: Appearance.normalize() };
let pendingSave = Promise.resolve();
const previewSheet = new CSSStyleSheet();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, previewSheet];

async function closeSettings() {
  await pendingSave;
  window.player.window('close');
}
$('#close-settings').onclick = closeSettings;
$('#done-settings').onclick = closeSettings;
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSettings(); });
function selectTab(name) {
  for (const id of ['general', 'theme']) {
    $(`#${id}-tab`).classList.toggle('active', name === id);
    $(`#${id}-tab`).setAttribute('aria-selected', String(name === id));
    $(`#${id}-panel`).hidden = name !== id;
  }
}
$('#general-tab').onclick = () => selectTab('general');
$('#theme-tab').onclick = () => selectTab('theme');

function persist() {
  $('#settings-status').textContent = '저장 중…';
  const snapshot = structuredClone(preferences);
  pendingSave = pendingSave.catch(() => {}).then(() => window.player.savePreferences(snapshot)).then(() => {
    $('#settings-status').textContent = '변경 내용이 저장되었습니다.';
  }).catch(() => { $('#settings-status').textContent = '저장하지 못했습니다. 다시 변경해주세요.'; });
  return pendingSave;
}
function update() {
  preferences.appearance = Appearance.apply(preferences.appearance);
  render(); persist();
}
function render() {
  const appearance = preferences.appearance;
  const palette = Appearance.palette(appearance);
  $('#close-to-tray').checked = preferences.closeToTray;
  $('#appearance-mode').value = appearance.mode;
  $('#appearance-font').value = appearance.font;
  $('#color-mode-label').textContent = `${palette.mode === 'dark' ? '다크' : '라이트'} 모드 색상`;
  for (const key of ['accent', 'background', 'foreground']) {
    $(`#${key}-color`).value = palette[key];
    if (document.activeElement !== $(`#${key}-hex`)) $(`#${key}-hex`).value = palette[key];
  }
  $('#theme-presets').replaceChildren();
  const rules = [];
  for (const [id, preset] of Object.entries(Appearance.presets)) {
    const [bg, fg, accent] = preset[palette.mode];
    const button = document.createElement('button');
    button.className = `theme-preset ${appearance.theme === id ? 'active' : ''}`;
    button.id = `preset-${id}`; button.setAttribute('aria-label', `${preset.name} 테마`);
    button.setAttribute('aria-pressed', String(appearance.theme === id));
    button.innerHTML = '<div class="theme-preview"><div class="preview-sidebar"></div><div class="preview-main"><i></i><i></i><i></i></div></div><span></span>';
    button.querySelector('span').textContent = preset.name;
    button.onclick = () => { appearance.theme = id; appearance.colors = { light: {}, dark: {} }; update(); };
    rules.push(`#preset-${id} .theme-preview{background:${bg}}#preset-${id} .preview-sidebar{background:${fg}18}#preset-${id} i{background:${fg}44}#preset-${id} i:first-child{background:${accent}}`);
    $('#theme-presets').append(button);
  }
  $('#accent-swatches').replaceChildren();
  ['#267bf5', '#8b5cf6', '#e05284', '#d98732', '#329576'].forEach((color, index) => {
    const button = document.createElement('button');
    button.id = `accent-swatch-${index}`; button.title = color; button.setAttribute('aria-label', `액센트 ${color}`);
    button.setAttribute('aria-pressed', String(palette.accent.toLowerCase() === color));
    button.onclick = () => changeColor('accent', color);
    rules.push(`#${button.id}{background:${color}}`); $('#accent-swatches').append(button);
  });
  previewSheet.replaceSync(rules.join('\n'));
}
function changeColor(key, value) {
  if (!Appearance.isColor(value)) return;
  preferences.appearance.colors[Appearance.palette(preferences.appearance).mode][key] = value;
  $(`#${key}-hex`).setAttribute('aria-invalid', 'false');
  update();
}
$('#close-to-tray').onchange = () => { preferences.closeToTray = $('#close-to-tray').checked; persist(); };
$('#appearance-mode').onchange = () => { preferences.appearance.mode = $('#appearance-mode').value; update(); };
$('#appearance-font').onchange = () => { preferences.appearance.font = $('#appearance-font').value; update(); };
$('#reset-theme').onclick = () => { preferences.appearance = Appearance.normalize(); update(); };
for (const key of ['accent', 'background', 'foreground']) {
  $(`#${key}-color`).oninput = () => changeColor(key, $(`#${key}-color`).value);
  $(`#${key}-hex`).onchange = () => {
    const value = $(`#${key}-hex`).value.trim();
    if (!Appearance.isColor(value)) { $(`#${key}-hex`).setAttribute('aria-invalid', 'true'); return; }
    changeColor(key, value);
  };
}
document.querySelectorAll('.reset-color').forEach(button => button.onclick = () => {
  delete preferences.appearance.colors[Appearance.palette(preferences.appearance).mode][button.dataset.color]; update();
});
window.addEventListener('appearance-mode-changed', render);
window.player.preferences().then(value => {
  preferences = { closeToTray: Boolean(value.closeToTray), appearance: Appearance.apply(value.appearance) };
  render();
}).catch(() => { $('#settings-status').textContent = '설정을 불러오지 못했습니다.'; });
