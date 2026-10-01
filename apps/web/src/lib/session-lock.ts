// This contains only a local UI disconnect flag, never a credential. Keep it
// across reloads so a failed DELETE cannot silently reuse an HttpOnly cookie.
const key = 'opencontext.disconnected';
let disconnected = false;

export function isLocallyDisconnected() {
  try {
    return disconnected || sessionStorage.getItem(key) === '1';
  } catch {
    return disconnected;
  }
}

export function setLocallyDisconnected(value: boolean) {
  disconnected = value;
  try {
    if (value) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    // Storage-disabled browsers still clear this page's in-memory session.
  }
}
