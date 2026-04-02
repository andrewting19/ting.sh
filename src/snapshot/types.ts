import type { RenderedTextSnapshot } from "./renderedTextSnapshot";
import type { XtermVtSnapshot } from "./xtermVtSnapshot";

export type TerminalSnapshot = XtermVtSnapshot | RenderedTextSnapshot;
