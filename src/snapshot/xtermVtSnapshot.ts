import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

export interface XtermVtSnapshot {
  format: "xterm-vt-snapshot-v1";
  cols: number;
  rows: number;
  payload: string;
  capturedAt: number;
}

type HeadlessTerminalWithAddon = Terminal & {
  loadAddon(addon: { activate(terminal: unknown): void; dispose(): void }): void;
};

export class XtermVtSnapshotTracker {
  private readonly term: HeadlessTerminalWithAddon;
  private readonly serializeAddon: SerializeAddon;
  private readonly decoder = new TextDecoder("utf-8");
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number, scrollback = 10_000) {
    this.term = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback,
    }) as HeadlessTerminalWithAddon;
    this.serializeAddon = new SerializeAddon();
    // The serialize addon is typed against the browser Terminal, but xterm's
    // own docs recommend the headless + serialize pairing for reconnection.
    this.term.loadAddon(this.serializeAddon);
  }

  get terminal(): Terminal {
    return this.term;
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const chunk = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    const next = this.pendingWrite.then(
      () => new Promise<void>((resolve) => this.term.write(chunk, () => resolve())),
    );
    this.pendingWrite = next.catch(() => {});
    await next;
  }

  capture(): XtermVtSnapshot {
    return {
      format: "xterm-vt-snapshot-v1",
      cols: this.term.cols,
      rows: this.term.rows,
      payload: this.serializeAddon.serialize(),
      capturedAt: Date.now(),
    };
  }

  async captureSettled(): Promise<XtermVtSnapshot> {
    await this.pendingWrite;
    return this.capture();
  }

  async restore(snapshot: XtermVtSnapshot): Promise<void> {
    this.term.reset();
    if (this.term.cols !== snapshot.cols || this.term.rows !== snapshot.rows) {
      this.term.resize(snapshot.cols, snapshot.rows);
    }
    await this.write(snapshot.payload);
  }
}
