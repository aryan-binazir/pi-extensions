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
  private paste: string[] | undefined;
  private closing = "";
  get pasting(): boolean { return this.paste !== undefined; }
  get holdingMarker(): boolean { return this.opening !== ""; }
  reset(): void {
    this.opening = "";
    this.paste = undefined;
    this.closing = "";
  }
  *feed(data: string): Generator<PasteFrame> {
    data = this.opening + data;
    this.opening = "";
    for (;;) {
      if (this.paste !== undefined) {
        data = this.closing + data;
        this.closing = "";
        const end = data.indexOf(END);
        if (end < 0) {
          const length = partialLength(data, END, 1);
          const content = length ? data.slice(0, -length) : data;
          if (content) this.paste.push(content);
          this.closing = length ? data.slice(-length) : "";
          return;
        }
        this.paste.push(data.slice(0, end));
        const payload = this.paste.join("");
        data = data.slice(end + END.length);
        this.paste = undefined;
        yield { type: "paste", data: payload };
        if (!data) return;
        continue;
      }
      const opener = data.indexOf(START);
      if (opener === 0) {
        this.paste = [];
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
