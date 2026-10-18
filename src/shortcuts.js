document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  const target = event.target;
  const input = target.closest('input');
  if (target.isContentEditable || target.closest('textarea, select') ||
      (input && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'hidden'].includes(input.type))) return;
  if (event.key === 'Tab') {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.altKey || event.metaKey || event.shiftKey) return;
  const action = event.ctrlKey
    ? ({ ArrowLeft: 'previous', ArrowRight: 'next' })[event.code]
    : ({ Space: 'play', ArrowLeft: 'seek-backward', ArrowRight: 'seek-forward', ArrowUp: 'volume-up', ArrowDown: 'volume-down', KeyM: 'mute', KeyS: 'shuffle', KeyR: 'repeat' })[event.code];
  if (!action) return;
  // Outside text editing, playback keys take priority over focused controls.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat || ['seek-backward', 'seek-forward', 'volume-up', 'volume-down'].includes(action)) {
    window.player.playbackShortcut(action);
  }
}, true);
