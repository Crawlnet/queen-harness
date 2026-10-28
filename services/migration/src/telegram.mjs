// Reports go to files in data/ only: no chat bot in this copy. The same exports the service calls, all no-ops.
export const tgEnabled = () => false;
export const tgCommandsEnabled = () => false;
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export async function sendReport() {}
export async function pollCommands() {}
