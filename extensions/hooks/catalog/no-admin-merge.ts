import { ghPrCommands, undecodableGh } from '../gh.ts';
import type { BlockHook } from '../types.ts';

export const noAdminMerge: BlockHook = {
  id: 'no-admin-merge',
  type: 'block',
  check({ toolName, input }) {
    if (toolName !== 'bash' || typeof input.command !== 'string') return;
    for (const command of ghPrCommands(input.command)) {
      if (command === 'undecodable') return undecodableGh;
      if (command.action === 'merge' && command.flags.has('--admin')) {
        return 'Merge without --admin. Satisfy the repository review and check requirements instead of bypassing them.';
      }
    }
  },
};
