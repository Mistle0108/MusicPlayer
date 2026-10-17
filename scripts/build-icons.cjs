const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'assets', 'icons');
const icons = {};
for (const file of fs.readdirSync(folder).filter(file => file.endsWith('.svg')).sort()) {
  const name = path.basename(file, '.svg');
  const svg = fs.readFileSync(path.join(folder, file), 'utf8').trim();
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) throw new Error(`Invalid SVG: ${file}`);
  icons[name] = svg.replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
}
if (!icons.music) throw new Error('Missing music.svg');
const output = `// Generated from assets/icons/*.svg by scripts/build-icons.cjs.\nwindow.PlayerIcons = Object.freeze(${JSON.stringify(icons, null, 2)});\nwindow.renderPlayerIcon = name => window.PlayerIcons[name] || window.PlayerIcons.music;\n`;
fs.writeFileSync(path.join(root, 'src', 'icons.js'), output, 'utf8');
console.log(`Applied ${Object.keys(icons).length} SVG icons.`);
