import * as twkan from './twkan.js';
import * as wfxs from './wfxs.js';
import * as novellunar from './novellunar.js';
import * as shuba69 from './shuba69.js';
import * as novel543 from './novel543.js';
import * as biquge from './biquge.js';
import * as ixdzs from './ixdzs.js';
import * as uukanshu from './uukanshu.js';

export const adapters = [twkan, wfxs, novellunar, shuba69, novel543, biquge, ixdzs, uukanshu];

export const adapterFor = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return adapters.find((a) => a.match(u) && a.bookId(u)) || null;
};

export const adapterByName = (name) => adapters.find((a) => a.name === name) || null;
