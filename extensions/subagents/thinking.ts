/**
 * Pi's thinking levels, in one place. Every validator and tool schema in this
 * extension derives from this list, which is why it has no imports: profiles.ts
 * reaches it from the show-config CLI under bare Node type stripping, and
 * registry.ts reaches it from a standalone child process.
 */
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const thinkingPattern = `(?:${THINKING.join('|')})`;
export const thinkingLevel = new RegExp(`^${thinkingPattern}$`);
export const thinkingSuffix = new RegExp(`:(${THINKING.join('|')})$`);
