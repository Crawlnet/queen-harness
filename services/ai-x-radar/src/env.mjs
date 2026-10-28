// .env next to package.json; process.env wins
import fs from 'fs';

const file = (() => { try { return fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; } })();
export const env = k => process.env[k] || file.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() || undefined;
export const DATA = new URL('../data/', import.meta.url);
fs.mkdirSync(DATA, { recursive: true });
