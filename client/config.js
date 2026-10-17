// hordes3d client — server URL resolution.
// Priority: ?server=wss://... query param (persisted) > localStorage > same-host default.

const KEY = 'hordes3d_server';

export function getServerUrl() {
  try {
    const q = new URLSearchParams(window.location.search).get('server');
    if (q && q.trim()) {
      window.localStorage.setItem(KEY, q.trim());
      return q.trim();
    }
    const saved = window.localStorage.getItem(KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch (e) { /* storage unavailable — fall through to default */ }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

// Value currently saved in localStorage ('' when none) — for prefilling the login form.
export function getSavedServer() {
  try { return window.localStorage.getItem(KEY) || ''; }
  catch (e) { return ''; }
}

export function clearServerOverride() {
  try { window.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}
