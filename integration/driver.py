"""Bounded JSON-lines transport to our owned local NEAR sandbox child.

No wallet material, user inputs or child stderr are copied to evidence. A timed
out mutation leaves state unknown; this transport never retries it implicitly.
"""
import json
import os
import queue
import signal
import subprocess
import threading
import time


class DriverError(RuntimeError):
    pass


class SandboxDriver:
    EOF_TIMEOUT = 15
    TERMINATE_TIMEOUT = 5
    KILL_TIMEOUT = 5
    READER_TIMEOUT = 2

    def __init__(self, command, cwd, stderr_path, timeout=120):
        self.command, self.cwd = command, cwd
        self.stderr_path, self.timeout = stderr_path, timeout
        self.process = None
        self.messages = queue.Queue()
        self.failed = False

    def __enter__(self):
        self.stderr = open(self.stderr_path, "xb")
        try:
            self.process = subprocess.Popen(self.command, cwd=self.cwd,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
                text=True, bufsize=1, start_new_session=True)
        except BaseException:
            self.stderr.close()
            raise
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        return self

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(1024 * 1024 + 1)
                if not line:
                    self.messages.put(DriverError("Sandbox driver exited"))
                    return
                if len(line) > 1024 * 1024 or not line.endswith("\n"):
                    self.messages.put(DriverError("Oversized sandbox response"))
                    return
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    self.messages.put(DriverError("Invalid sandbox JSON response"))
                    return
        except (OSError, ValueError):
            self.messages.put(DriverError("Sandbox response stream closed"))

    def receive(self):
        if self.failed:
            raise DriverError("Driver state unknown; restart a fresh synthetic run")
        try:
            message = self.messages.get(timeout=self.timeout)
        except queue.Empty:
            self.failed = True
            raise DriverError("Sandbox response timed out; mutation outcome UNKNOWN, no retry") from None
        if isinstance(message, Exception):
            self.failed = True
            raise message
        if type(message) is not dict:
            self.failed = True
            raise DriverError("Sandbox response must be an object")
        return message

    def request(self, command):
        if self.failed:
            raise DriverError("Driver state unknown; no mutation retry")
        encoded = json.dumps(command, allow_nan=False, separators=(",", ":"))
        if len(encoded) > 65536:
            raise DriverError("Sandbox command exceeds local limit")
        try:
            self.process.stdin.write(encoded + "\n")
            self.process.stdin.flush()
        except (OSError, ValueError):
            self.failed = True
            raise DriverError("Sandbox command delivery failed; outcome UNKNOWN") from None
        return self.receive()

    def _signal_group(self, sig):
        # start_new_session makes the child's PID its owned process-group ID.
        # Keep that ID even after the leader exits: sandbox descendants can survive it.
        try:
            os.killpg(self.process.pid, sig)
        except ProcessLookupError:
            pass

    def _wait_group(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            self.process.poll()  # Reap the leader so it cannot keep an empty group alive.
            try:
                os.killpg(self.process.pid, 0)
            except ProcessLookupError:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(.05, remaining))

    def __exit__(self, *exc):
        try:
            if self.process is not None:
                try:
                    self.process.stdin.close()  # Prefer normal EOF/RAII sandbox cleanup.
                except (OSError, ValueError):
                    pass
                try:
                    self.process.wait(timeout=self.EOF_TIMEOUT)
                except subprocess.TimeoutExpired:
                    pass
                # Also clean descendants when the leader already exited on its own.
                self._signal_group(signal.SIGTERM)
                if not self._wait_group(self.TERMINATE_TIMEOUT):
                    self._signal_group(signal.SIGKILL)
                    self._wait_group(self.KILL_TIMEOUT)
                self.process.wait(timeout=self.KILL_TIMEOUT)
                # TextIO.close can block on the reader's lock while a descendant
                # holds the write end. Join first and never close under a live reader.
                self.reader.join(timeout=self.READER_TIMEOUT)
                if self.reader.is_alive():
                    self.failed = True
                    if not exc or exc[0] is None:
                        raise DriverError("Sandbox cleanup incomplete; stdout reader did not stop")
                else:
                    self.process.stdout.close()
        finally:
            self.stderr.close()
