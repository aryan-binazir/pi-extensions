import type { Hook } from '../types.ts';
import { draftPrs } from './draft-prs.ts';
import { noAdminMerge } from './no-admin-merge.ts';
import { rgReplaceFlag } from './rg-replace-flag.ts';

/** Every hook, in the order hooks of the same type run. */
export const catalog: readonly Hook[] = [draftPrs, noAdminMerge, rgReplaceFlag];
