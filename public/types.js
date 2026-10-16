// Upload rules shared by the Worker and the browser. One list, enforced in both places.

export const AUDIO = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aiff: 'audio/aiff', aif: 'audio/aiff',
  weba: 'audio/webm',
};
export const IMAGE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
};
export const MAX = { audio: 1024 ** 3, cover: 25 * 1024 ** 2 };
// Backblaze counts GB as 10^9 bytes; the free tier is 10 GB.
export const STORAGE_LIMIT = 10e9;

export const ACCEPT_AUDIO = Object.keys(AUDIO).map(e => '.' + e).join(',');
export const ACCEPT_IMAGE = Object.keys(IMAGE).map(e => '.' + e).join(',');

export const ext = name => (/\.([^./]+)$/.exec(name || '')?.[1] || '').toLowerCase();
export const kindOf = name => (AUDIO[ext(name)] ? 'audio' : IMAGE[ext(name)] ? 'cover' : null);
export const contentType = name => AUDIO[ext(name)] || IMAGE[ext(name)];

// Checks a file's first 16 bytes, so a renamed .exe can't pass as audio.
export function sniff(b) {
  const at = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'cover'; // jpeg
  if (b[0] === 0x89 && at(1, 'PNG')) return 'cover';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'cover';
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    return ['heic', 'heix', 'heif', 'mif1', 'msf1', 'hevc'].includes(brand) ? 'cover' : 'audio'; // else m4a/mp4
  }
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio'; // mp3, adts aac
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio';
  if (at(0, 'fLaC') || at(0, 'OggS')) return 'audio';
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'audio';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio'; // webm (recordings)
  return null;
}

// The file extension for a content type (for naming downloads of files whose key has none, like Google Drive's).
export const extForType = type => Object.keys(AUDIO).find(e => AUDIO[e] === String(type || '').split(';')[0]) || ({ 'audio/x-wav': 'wav', 'audio/x-flac': 'flac', 'audio/x-m4a': 'm4a', 'audio/mp3': 'mp3', 'audio/x-aiff': 'aiff' })[String(type || '').split(';')[0]] || '';
