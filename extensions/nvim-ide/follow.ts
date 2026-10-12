import { basename } from 'node:path';
import type { IdeLink } from './link.ts';

export type FollowClock = { now(): number; setTimeout(callback: () => void, ms: number): () => void };
type FollowLink = Pick<IdeLink, 'connected' | 'call'>;
type FollowOptions = { link: () => FollowLink | undefined; cwd: () => string; following: () => boolean; warn: (message: string) => void; clock?: FollowClock };
const realClock: FollowClock = {
  now: () => Date.now(),
  setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return () => clearTimeout(timer); },
};

export class FollowQueue {
  private pending?: { args: Record<string, unknown>; at: number };
  private timer?: () => void;
  private inFlight?: AbortController;
  private failed = false;
  private seenEditor = false;
  private followCwd?: string;
  private readonly clock: FollowClock;
  constructor(private readonly options: FollowOptions) { this.clock = options.clock ?? realClock; }
  cancel(): void {
    this.timer?.();
    this.timer = undefined;
    this.pending = undefined;
    this.followCwd = undefined;
    const controller = this.inFlight;
    this.inFlight = undefined;
    controller?.abort();
  }
  reset(): void { this.cancel(); this.seenEditor = false; this.failed = false; }
  succeeded(link: FollowLink): void { if (this.options.link() === link) this.failed = false; }
  enqueue(filePath: string, cwd: string): void {
    if (!this.options.following() || !this.seenEditor) return;
    if (this.followCwd !== undefined && this.followCwd !== cwd) this.cancel();
    this.followCwd = cwd;
    this.pending = { args: { filePath, preview: false, makeFrontmost: false }, at: this.clock.now() };
    this.update();
  }
  update(): void {
    if (this.options.link()?.connected) this.seenEditor = true;
    if (!this.options.following() || (this.followCwd !== undefined && this.followCwd !== this.options.cwd())) { this.cancel(); return; }
    if (!this.pending || !this.options.link()?.connected || this.timer || this.inFlight) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      const current = this.options.link(), destination = this.pending;
      if (this.followCwd !== this.options.cwd()) { this.cancel(); return; }
      if (!this.options.following() || !current?.connected || !destination) return;
      this.pending = undefined;
      if (this.clock.now() - destination.at > 30_000) return;
      const controller = new AbortController();
      this.inFlight = controller;
      const deadline = this.clock.setTimeout(() => controller.abort(), 5000);
      void current.call('openFile', destination.args, controller.signal).then(() => {
        if (this.inFlight === controller && this.options.link() === current) this.failed = false;
      }).catch(error => {
        if (this.inFlight !== controller || this.options.link() !== current) return;
        if (!current.connected) this.pending ??= destination;
        else if (!this.failed) {
          this.failed = true;
          this.options.warn(`Could not reveal ${basename(String(destination.args.filePath))} in the editor: ${error instanceof Error ? error.message : String(error)}`);
        }
      }).finally(() => {
        deadline();
        if (this.inFlight !== controller) return;
        this.inFlight = undefined;
        this.update();
      });
    }, 100);
  }
}
