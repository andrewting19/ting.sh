export interface SequencedChunk {
  seq: number;
  data: Buffer;
}

export class LiveTailBuffer {
  private readonly maxBytes: number;
  private chunks: SequencedChunk[] = [];
  private totalBytes = 0;
  private lastSeq = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, maxBytes);
  }

  append(data: Uint8Array | Buffer): number {
    const payload = Buffer.from(data);
    if (payload.length === 0) return this.lastSeq;

    this.lastSeq += 1;
    this.chunks.push({ seq: this.lastSeq, data: payload });
    this.totalBytes += payload.length;
    this.trim();
    return this.lastSeq;
  }

  latestSeq(): number {
    return this.lastSeq;
  }

  getAfter(seq: number): SequencedChunk[] {
    return this.chunks.filter((chunk) => chunk.seq > seq);
  }

  totalSize(): number {
    return this.totalBytes;
  }

  private trim(): void {
    if (this.maxBytes <= 0) {
      this.chunks = [];
      this.totalBytes = 0;
      return;
    }

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.data.length;
    }
  }
}
