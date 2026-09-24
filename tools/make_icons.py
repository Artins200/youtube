#!/usr/bin/env python3
"""Generate app icons (YouTube-style red play badge) as PNG files, no deps."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'app', 'icons')
SS = 4  # supersampling factor for antialiasing


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, w, h, pixels: bytearray):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter: none
        raw += pixels[y * stride:(y + 1) * stride]
    data = zlib.compress(bytes(raw), 9)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', data)
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


class Canvas:
    def __init__(self, size, bg=(0, 0, 0, 0)):
        self.s = size
        self.px = bytearray(bytes(bg) * (size * size))

    def set(self, x, y, color):
        if 0 <= x < self.s and 0 <= y < self.s:
            i = (y * self.s + x) * 4
            self.px[i:i + 4] = bytes(color)

    def fill(self, color):
        self.px = bytearray(bytes(color) * (self.s * self.s))

    def rounded_rect(self, x0, y0, x1, y1, r, color):
        s = self.s
        for y in range(max(0, int(y0)), min(s, int(y1) + 1)):
            for x in range(max(0, int(x0)), min(s, int(x1) + 1)):
                cx = min(max(x, x0 + r), x1 - r)
                cy = min(max(y, y0 + r), y1 - r)
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    self.set(x, y, color)

    def triangle(self, p0, p1, p2, color):
        s = self.s
        minx = max(0, int(min(p0[0], p1[0], p2[0])))
        maxx = min(s - 1, int(max(p0[0], p1[0], p2[0])) + 1)
        miny = max(0, int(min(p0[1], p1[1], p2[1])))
        maxy = min(s - 1, int(max(p0[1], p1[1], p2[1])) + 1)

        def sign(a, b, c):
            return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

        for y in range(miny, maxy + 1):
            for x in range(minx, maxx + 1):
                p = (x, y)
                d1, d2, d3 = sign(p, p0, p1), sign(p, p1, p2), sign(p, p2, p0)
                neg = d1 < 0 or d2 < 0 or d3 < 0
                pos = d1 > 0 or d2 > 0 or d3 > 0
                if not (neg and pos):
                    self.set(x, y, color)

    def downsample(self, factor):
        s, n = self.s, self.s // factor
        out = bytearray(n * n * 4)
        for y in range(n):
            for x in range(n):
                r = g = b = a = 0
                for dy in range(factor):
                    for dx in range(factor):
                        i = (((y * factor + dy) * s) + (x * factor + dx)) * 4
                        r += self.px[i]
                        g += self.px[i + 1]
                        b += self.px[i + 2]
                        a += self.px[i + 3]
                k = factor * factor
                o = (y * n + x) * 4
                out[o] = r // k
                out[o + 1] = g // k
                out[o + 2] = b // k
                out[o + 3] = a // k
        return n, out


RED = (255, 0, 0, 255)
WHITE = (255, 255, 255, 255)


def render(size_out, pad_ratio=0.0):
    """pad_ratio: extra white margin (for maskable icons)."""
    S = size_out * SS
    c = Canvas(S)
    c.fill(WHITE)
    # YouTube play badge: aspect ~1.4:1, centered
    pad = 0.09 + pad_ratio
    bw = S * (1 - 2 * pad)
    bh = bw / 1.4
    x0 = (S - bw) / 2
    y0 = (S - bh) / 2
    x1, y1 = x0 + bw, y0 + bh
    r = bh * 0.23
    c.rounded_rect(x0, y0, x1, y1, r, RED)
    # white play triangle, optically centered
    cx, cy = S / 2 + bw * 0.045, S / 2
    tw, th = bw * 0.235, bh * 0.36
    c.triangle((cx - tw / 2, cy - th / 2), (cx + tw / 2, cy), (cx - tw / 2, cy / 2 + cy / 2 + th / 2), WHITE)
    return c.downsample(SS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, pad in [
        ('icon-192.png', 192, 0.0),
        ('icon-512.png', 512, 0.0),
        ('icon-maskable-512.png', 512, 0.08),
        ('apple-touch-icon.png', 180, 0.04),
    ]:
        n, px = render(size, pad)
        path = os.path.join(OUT, name)
        write_png(path, n, n, px)
        print('wrote', path, f'{n}x{n}')


if __name__ == '__main__':
    main()
