/**
 * Replay safety for truncated scrollback.
 *
 * When we cap raw bytes at MAX_BUFFER we can cut in the middle of a line or
 * multibyte sequence. On attach, drop the first partial line to avoid replaying
 * half an ANSI sequence and starting xterm in a visually broken state.
 */
export function sanitizeReplayBuffer(buffer: Buffer, wasTrimmed: boolean): Buffer {
  if (!wasTrimmed || buffer.length === 0) return buffer

  // If the slice starts inside a UTF-8 continuation byte, skip to a boundary.
  let start = 0
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++

  // First line may be partial because the cap cuts arbitrary bytes.
  // Dropping it is safer than replaying broken escape fragments.
  const newline = buffer.indexOf(0x0a, start)
  if (newline !== -1 && newline + 1 < buffer.length) return buffer.subarray(newline + 1)

  return buffer.subarray(start)
}

function countByte(buffer: Buffer, value: number): number {
  let count = 0
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === value) count += 1
  }
  return count
}

export function getReplayBufferStats(buffer: Buffer, wasTrimmed: boolean): {
  replay: Buffer
  replayBytes: number
  replayLineBreaks: number
  replayTrimmed: boolean
} {
  const replay = sanitizeReplayBuffer(buffer, wasTrimmed)
  return {
    replay,
    replayBytes: replay.length,
    replayLineBreaks: countByte(replay, 0x0a),
    replayTrimmed: wasTrimmed,
  }
}
