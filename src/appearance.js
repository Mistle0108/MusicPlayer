(() => {
  const presets = {
    default: { name: '기본', light: ['#ffffff', '#172032', '#267bf5'], dark: ['#202123', '#eceef2', '#669bff'] },
    graphite: { name: '그래파이트', light: ['#faf9f7', '#292826', '#6d6b68'], dark: ['#1c1c1c', '#e6e6e4', '#b5b2ab'] },
    ocean: { name: '오션', light: ['#f6faff', '#19334a', '#2476bf'], dark: ['#16232f', '#dfedf8', '#6db6ed'] },
    forest: { name: '포레스트', light: ['#f6faf7', '#263d32', '#328363'], dark: ['#192620', '#e1eee5', '#7cbb97'] },
    sand: { name: '샌드', light: ['#fbf7ef', '#44392e', '#a7763b'], dark: ['#2a241e', '#f0e7da', '#d9b07b'] }
  };
  const fonts = ['Segoe UI', 'Malgun Gothic', 'Arial', 'Verdana', 'Consolas', 'Georgia'];
  const systemMode = matchMedia('(prefers-color-scheme: dark)');
  const themeSheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet];
  let current;
  const isColor = value => /^#[0-9a-f]{6}$/i.test(value || '');
  function normalize(value = {}) {
    const colors = {};
    for (const mode of ['light', 'dark']) {
      colors[mode] = {};
      for (const key of ['accent', 'background', 'foreground']) {
        if (isColor(value.colors?.[mode]?.[key])) colors[mode][key] = value.colors[mode][key];
      }
    }
    return {
      mode: ['system', 'light', 'dark'].includes(value.mode) ? value.mode : 'light',
      theme: presets[value.theme] ? value.theme : 'default',
      colors, font: fonts.includes(value.font) ? value.font : 'Segoe UI'
    };
  }
  const resolvedMode = value => value.mode === 'system' ? (systemMode.matches ? 'dark' : 'light') : value.mode;
  function palette(value) {
    const mode = resolvedMode(value);
    const [background, foreground, accent] = presets[value.theme][mode];
    return { mode, background, foreground, accent, ...value.colors[mode] };
  }
  function mix(a, b, weight) {
    const channel = offset => Math.round(parseInt(a.slice(offset, offset + 2), 16) * (1 - weight) + parseInt(b.slice(offset, offset + 2), 16) * weight).toString(16).padStart(2, '0');
    return `#${channel(1)}${channel(3)}${channel(5)}`;
  }
  function apply(value) {
    current = normalize(value);
    const colors = palette(current);
    const { background: bg, foreground: fg, accent } = colors;
    const luminance = color => [.2126, .7152, .0722].reduce((sum, factor, index) => {
      const channel = parseInt(color.slice(index * 2 + 1, index * 2 + 3), 16) / 255;
      return sum + factor * (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    }, 0);
    const onAccent = luminance(accent) > .35 ? '#101114' : '#ffffff';
    const values = {
      '--bg': bg, '--fg': fg, '--blue': accent, '--on-accent': onAccent,
      '--surface': mix(bg, fg, .025), '--surface-raised': mix(bg, fg, .012),
      '--hover': mix(bg, fg, .055), '--line': mix(bg, fg, .11),
      '--muted': mix(bg, fg, .64), '--subtle': mix(bg, fg, .48),
      '--selected': mix(bg, accent, .14), '--accent-hover': mix(accent, fg, .16),
      '--range-track': mix(bg, fg, .15), '--cover-start': mix(bg, accent, .12),
      '--cover-end': mix(bg, accent, .26), '--cover-ink': mix(bg, accent, .66),
      '--danger': colors.mode === 'dark' ? '#f08e96' : '#c64b56',
      '--font': `"${current.font}", "Malgun Gothic", sans-serif`
    };
    themeSheet.replaceSync(`:root{color-scheme:${colors.mode};${Object.entries(values).map(([key, entry]) => `${key}:${entry}`).join(';')}}`);
    document.documentElement.dataset.colorMode = colors.mode;
    return current;
  }
  systemMode.addEventListener('change', () => {
    if (current?.mode === 'system') {
      apply(current);
      window.dispatchEvent(new Event('appearance-mode-changed'));
    }
  });
  window.Appearance = { presets, fonts, normalize, palette, apply, isColor };
  apply();
})();
