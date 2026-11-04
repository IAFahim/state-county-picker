#!/usr/bin/env python3
"""Local dev server. Mimics GitHub Pages: unknown paths like /xyz or /l/xyz are sent to the app as /?p=/xyz."""
import http.server, os, sys, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        local = os.path.join(ROOT, path.lstrip("/"))
        if path != "/" and not os.path.exists(local) and "." not in os.path.basename(path):
            self.send_response(302)
            self.send_header("Location", "/?p=" + urllib.parse.quote(path))
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
