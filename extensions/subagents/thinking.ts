const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const thinkingPattern = `(?:${THINKING.join('|')})`;
export const thinkingLevel = new RegExp(`^${thinkingPattern}$`);
export const thinkingSuffix = new RegExp(`:(${THINKING.join('|')})$`);
