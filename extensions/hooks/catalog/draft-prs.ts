import { ghPrCommands, undecodableGh } from '../gh.ts';
import type { BlockHook } from '../types.ts';

export const draftPrs: BlockHook = {
  id: 'draft-prs',
  type: 'block',
  check({ toolName, input }) {
    if (toolName !== 'bash' || typeof input.command !== 'string') return;
    for (const command of ghPrCommands(input.command)) {
      if (command === 'undecodable') return undecodableGh;
      if (command.action !== 'create') continue;
      if (command.flags.has('--web')) return 'gh cannot create drafts with --web. Drop --web/-w and pass --draft.';
      if (!command.flags.has('--draft')) return 'Create PRs as drafts. Add --draft; mark ready with gh pr ready after review.';
    }
  },
};
