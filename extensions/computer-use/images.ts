import type { ImageContent, ModelImageResizeOptions, TextContent } from '@earendil-works/pi-ai';
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';
import { getImageDimensions } from '@earendil-works/pi-tui';

const omitted = '[Screenshot omitted: the image could not be processed within the model image limits, so it was not sent.]';

function decodable(image: ImageContent) {
  const size = getImageDimensions(image.data, image.mimeType);
  return !!size && size.widthPx > 0 && size.heightPx > 0 && size.widthPx <= 32768 && size.heightPx <= 32768 && size.widthPx * size.heightPx <= 64_000_000;
}

export async function boundImages(content: (TextContent | ImageContent)[], resize?: ModelImageResizeOptions, signal?: AbortSignal): Promise<(TextContent | ImageContent)[]> {
  const bounded: (TextContent | ImageContent)[] = [];
  for (const block of content) {
    if (block.type === 'text') { bounded.push(block); continue; }
    signal?.throwIfAborted();
    const resized = decodable(block) ? await resizeImage(Buffer.from(block.data, 'base64'), block.mimeType, resize).catch(() => null) : null;
    if (!resized) { bounded.push({ type: 'text', text: omitted }); continue; }
    bounded.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
    const note = formatDimensionNote(resized);
    if (note) bounded.push({ type: 'text', text: note });
  }
  return bounded;
}
