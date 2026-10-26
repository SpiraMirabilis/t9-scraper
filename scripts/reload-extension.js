// Reload the unpacked extension in the scraper's Chrome after editing
// extension/ or running build-inpage.js -- no noVNC trip needed. It briefly
// listens on the extension's WebSocket port, so don't run it while an
// extension-engine job is running (stop the service, or wait for idle).
const { reloadExtension } = await import('../src/engines/extension.js');
await reloadExtension();
console.log('reload sent');
process.exit(0);
