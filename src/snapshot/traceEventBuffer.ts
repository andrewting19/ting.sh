export type TraceEvent =
  | { type: "data"; data: Buffer }
  | { type: "resize"; cols: number; rows: number };

export type SerializableTraceEvent =
  | { type: "data"; base64: string; bytes: number }
  | { type: "resize"; cols: number; rows: number };

export class TraceEventBuffer {
  private readonly maxBytes: number;
  private events: TraceEvent[] = [];
  private dataBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, maxBytes);
  }

  appendData(data: Uint8Array | Buffer): void {
    const payload = Buffer.from(data);
    if (payload.length === 0) return;
    this.events.push({ type: "data", data: payload });
    this.dataBytes += payload.length;
    this.trim();
  }

  appendResize(cols: number, rows: number): void {
    this.events.push({ type: "resize", cols, rows });
    this.trim();
  }

  totalDataBytes(): number {
    return this.dataBytes;
  }

  count(): number {
    return this.events.length;
  }

  serialize(): SerializableTraceEvent[] {
    return this.events.map((event) => (
      event.type === "data"
        ? { type: "data", base64: event.data.toString("base64"), bytes: event.data.length }
        : event
    ));
  }

  private trim(): void {
    if (this.maxBytes <= 0) {
      this.events = [];
      this.dataBytes = 0;
      return;
    }

    while (this.dataBytes > this.maxBytes) {
      const index = this.events.findIndex((event) => event.type === "data");
      if (index === -1) break;
      const [removed] = this.events.splice(index, 1);
      if (removed.type === "data") this.dataBytes -= removed.data.length;
    }
  }
}
