/**
 * An address, a transaction id or an encoded blob in a text: a run of 32 or more letters and digits (base58, hex,
 * base64), or 0x and 40 hex. The answer's data links are matched by the ids they hold (harness brain.ts answerSources).
 */
export const LONG_ID = /(?<![\p{L}\p{N}])(?:0x[0-9a-f]{40}|[0-9a-z]{32,})(?![\p{L}\p{N}])/giu;
