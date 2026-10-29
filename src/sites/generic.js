// Fallback for page jobs on hosts no adapter knows: no site logic, only the
// shared in-page helpers (challenge detection). Not in the adapter list, so
// it never claims a chapter/TOC URL or shows up in /supported_sites; tune it
// in sites.json under "generic".
export const name = 'generic';
export const hosts = [];
export const match = () => false;
export const bookId = () => null;

// In-page half: nothing site-specific ("common.*" calls still work).
export function makeSite() { return {}; }
