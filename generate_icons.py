import math
from PIL import Image, ImageDraw, ImageFilter

def create_master_icon(size=1024):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center = size // 2
    
    # 1. Background rounded squircle
    margin = int(size * 0.04)
    radius = int(size * 0.22)
    box = [margin, margin, size - margin, size - margin]
    
    # Base dark carbon background with subtle border
    draw.rounded_rectangle(box, radius=radius, fill=(16, 19, 27, 255), outline=(46, 52, 68, 255), width=int(size * 0.015))

    # Inner subtle background glow
    inner_box = [margin + int(size * 0.02), margin + int(size * 0.02), size - margin - int(size * 0.02), size - margin - int(size * 0.02)]
    draw.rounded_rectangle(inner_box, radius=radius - int(size * 0.02), fill=(21, 25, 36, 255))

    # 2. 4 Provider Arcs (Circular Metering Gauge)
    # Claude: Amber (#F59E0B)
    # Gemini: Cyber Gold (#EAB308)
    # MiniMax: Lime (#84CC16)
    # Codex: Emerald Teal (#10A37F)
    outer_r = int(size * 0.40)
    inner_r = int(size * 0.32)
    arc_width = outer_r - inner_r

    bbox_outer = [center - outer_r, center - outer_r, center + outer_r, center + outer_r]

    # Angles with gaps (total 360 deg)
    gap = 12
    # 4 segments:
    # Top-Left: Claude (135 to 215)
    # Top-Right: Gemini (225 to 305)
    # Bottom-Right: MiniMax (315 to 395/35)
    # Bottom-Left: Codex (45 to 125)
    segments = [
      (135 + gap//2, 225 - gap//2, (245, 158, 11, 255)), # Claude (Amber)
      (225 + gap//2, 315 - gap//2, (234, 179, 8, 255)),  # Gemini (Cyber Yellow)
      (315 + gap//2, 405 - gap//2, (132, 204, 22, 255)), # MiniMax (Lime)
      (45 + gap//2, 135 - gap//2, (16, 163, 127, 255))   # Codex (Teal/Emerald)
    ]

    for start_deg, end_deg, color in segments:
        draw.arc(bbox_outer, start=start_deg, end=end_deg, fill=color, width=arc_width)

    # 3. Small circular tick markers at key compass points
    for angle in [0, 45, 90, 135, 180, 225, 270, 315]:
        rad = math.radians(angle)
        tx = center + int(math.cos(rad) * (outer_r + int(size * 0.035)))
        ty = center + int(math.sin(rad) * (outer_r + int(size * 0.035)))
        tr = int(size * 0.01)
        draw.ellipse([tx - tr, ty - tr, tx + tr, ty + tr], fill=(120, 130, 150, 200))

    # 4. Central Energy Bolt / Quota Spark (Lightning symbol)
    # High-contrast bold lightning for instant recognition even at 16x16
    bolt_points = [
        (int(size * 0.54), int(size * 0.22)),  # Top right start
        (int(size * 0.38), int(size * 0.48)),  # Left inner crook
        (int(size * 0.50), int(size * 0.48)),  # Mid waist right
        (int(size * 0.44), int(size * 0.78)),  # Bottom tip
        (int(size * 0.64), int(size * 0.46)),  # Right outer crook
        (int(size * 0.52), int(size * 0.46)),  # Mid waist left
    ]
    
    # Outer subtle bolt glow/shadow
    draw.polygon(bolt_points, fill=(255, 230, 0, 255))
    
    # Inner bright highlight for bolt (depth & shine)
    inner_bolt = [
        (int(size * 0.53), int(size * 0.25)),
        (int(size * 0.42), int(size * 0.47)),
        (int(size * 0.50), int(size * 0.47)),
        (int(size * 0.46), int(size * 0.72)),
        (int(size * 0.60), int(size * 0.47)),
        (int(size * 0.52), int(size * 0.47)),
    ]
    draw.polygon(inner_bolt, fill=(255, 255, 240, 255))

    return img

def main():
    print("Generating Master 1024x1024 Icon...")
    master = create_master_icon(1024)
    
    sizes = [
        ("icon-16.png", 16),
        ("icon-32.png", 32),
        ("icon-48.png", 48),
        ("icon-128.png", 128),
        ("icon.png", 128),
        ("favicon.png", 32)
    ]
    
    for filename, s in sizes:
        resized = master.resize((s, s), Image.Resampling.LANCZOS)
        resized.save(filename, "PNG", optimize=True)
        print(f"Saved {filename} ({s}x{s})")

    # Generate multi-size favicon.ico (16, 32, 48)
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    master.save("favicon.ico", format="ICO", sizes=ico_sizes)
    print("Saved favicon.ico")

if __name__ == "__main__":
    main()
