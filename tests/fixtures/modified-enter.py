"""Report terminal key bytes without submitting a shell command."""

import os
import sys
import termios
import tty

fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    print("KEY_PROBE_READY", flush=True)
    received = bytearray()
    while True:
        value = os.read(fd, 1)
        if not value or value == b"Z":
            break
        received.extend(value)
    print("\r\nKEY_PROBE_HEX=" + received.hex(), flush=True)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
