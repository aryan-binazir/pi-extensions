import type { ModelImageResizeOptions } from '@earendil-works/pi-ai';
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const omitted = '[Screenshot omitted: the image could not be processed within the model image limits, so it was not sent.]';

export async function boundImages(content: Content[], resize?: ModelImageResizeOptions, signal?: AbortSignal): Promise<Content[]> {
  const bounded: Content[] = [];
  for (const block of content) {
    if (block.type === 'text') { bounded.push(block); continue; }
    signal?.throwIfAborted();
    const resized = await resizeImage(Buffer.from(block.data, 'base64'), block.mimeType, resize).catch(() => null);
    if (!resized) { bounded.push({ type: 'text', text: omitted }); continue; }
    bounded.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
    const note = formatDimensionNote(resized);
    if (note) bounded.push({ type: 'text', text: note });
  }
  return bounded;
}
