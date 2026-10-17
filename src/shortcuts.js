document.addEventListener('keydown', event => {
  if (event.altKey || event.metaKey || event.shiftKey) return;
  const action = event.ctrlKey
    ? ({ ArrowLeft: 'previous', ArrowRight: 'next' })[event.code]
    : ({ Space: 'play', ArrowLeft: 'seek-backward', ArrowRight: 'seek-forward', ArrowUp: 'volume-up', ArrowDown: 'volume-down', KeyM: 'mute', KeyS: 'shuffle', KeyR: 'repeat' })[event.code];
  if (!action) return;
  // Reserved playback keys must never type text or operate the focused control.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat || ['seek-backward', 'seek-forward', 'volume-up', 'volume-down'].includes(action)) {
    window.player.playbackShortcut(action);
  }
}, true);
