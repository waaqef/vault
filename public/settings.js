// Per-device preferences (saved in this browser only).
export const ACCENTS = [
  ['#ffd23f', 'Yellow'], ['#4d8dff', 'Blue'], ['#9b7bff', 'Violet'], ['#3ecf8e', 'Green'],
  ['#ff8a3d', 'Orange'], ['#ff5c8a', 'Pink'], ['#e8e8e8', 'Silver'],
];
const DEFAULTS = { accent: '#ffd23f', oled: false, motion: true, columns: true, autoplay: true, shareDays: '', detect: true, skipDups: true, artist: '', saveFormat: 'mp3', glass: true, crossfade: 0, refined: true, keepPlayed: true };

let saved = {};
try { saved = JSON.parse(localStorage.getItem('settings') || '{}'); } catch {}
// Oct 2026: the accent went back to yellow. Switch every device over once; picking another colour afterwards sticks.
if (!saved.yellowAccent) { saved.accent = DEFAULTS.accent; saved.yellowAccent = true; try { localStorage.setItem('settings', JSON.stringify(saved)); } catch {} }
export const settings = { ...DEFAULTS, ...saved };

export function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--user-accent', settings.accent);
  // text on top of the accent: dark on light colours (yellow, silver), white on dark ones
  const [r, g, b] = [1, 3, 5].map(i => parseInt(settings.accent.slice(i, i + 2), 16) / 255);
  root.style.setProperty('--on-accent', 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#141414' : '#fff');
  root.classList.toggle('oled', settings.oled);
  root.classList.toggle('no-motion', !settings.motion);
  root.classList.toggle('no-cols', !settings.columns);
  root.classList.toggle('glassy', settings.glass); // "Glass everywhere"
  root.classList.toggle('refined', settings.refined); // "Refined look"
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', settings.oled ? '#000000' : '#191919');
}

export function setSetting(key, value) {
  settings[key] = value;
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {}
  applySettings();
}

applySettings();
