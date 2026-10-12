const START = "\x1b[200~";
const END = "\x1b[201~";
export type PasteFrame = { type: "key" | "paste"; data: string };

function partialLength(data: string, marker: string, minimum: number): number {
  for (let size = Math.min(data.length, marker.length - 1); size >= minimum; size--)
    if (marker.startsWith(data.slice(-size))) return size;
  return 0;
}

export class PasteFramer {
  private opening = "";
  private paste: string | undefined;
  get pasting(): boolean { return this.paste !== undefined; }
  get holdingMarker(): boolean {
    return this.opening !== "" || (this.paste !== undefined && partialLength(this.paste, END, 1) > 0);
  }
  reset(): void {
    this.opening = "";
    this.paste = undefined;
  }
  *feed(data: string): Generator<PasteFrame> {
    data = this.opening + data;
    this.opening = "";
    for (;;) {
      if (this.paste !== undefined) {
        const searchFrom = Math.max(0, this.paste.length - END.length + 1);
        this.paste += data;
        const end = this.paste.indexOf(END, searchFrom);
        if (end < 0) return;
        const payload = this.paste.slice(0, end);
        data = this.paste.slice(end + END.length);
        this.paste = undefined;
        yield { type: "paste", data: payload };
        if (!data) return;
        continue;
      }
      const opener = data.indexOf(START);
      if (opener === 0) {
        this.paste = "";
        data = data.slice(START.length);
        continue;
      }
      let key = opener < 0 ? data : data.slice(0, opener);
      let length = partialLength(key, START, 3);
      const held = length ? key.slice(-length) : "";
      while (length) {
        key = key.slice(0, -length);
        length = partialLength(key, START, 3);
      }
      if (key || data === "") yield { type: "key", data: key };
      this.opening = opener < 0 ? held : "";
      if (opener < 0) return;
      data = data.slice(opener);
    }
  }
}
