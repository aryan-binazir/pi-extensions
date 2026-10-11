import type { Hook } from '../types.ts';
import { draftPrs } from './draft-prs.ts';
import { noAdminMerge } from './no-admin-merge.ts';
import { rgReplaceFlag } from './rg-replace-flag.ts';

/** Every hook, in the order hooks of the same type run. Switch them on in personal-settings/hooks.yaml. */
export const catalog: readonly Hook[] = [draftPrs, noAdminMerge, rgReplaceFlag];
