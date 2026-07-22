import re, wave, struct, os, subprocess, sys

GUITAR = sys.argv[1] if len(sys.argv) > 1 else 'FS'
BASE = '/tmp/IDMT-SMT-GUITAR_V2/dataset2'
OUT = f'/Users/dandorci/guitar-find-note/samples/{GUITAR}'
# app row -> dataset file suffix (row 0 = high e)
ROWS = ['E1', 'B', 'G', 'D', 'A', 'E']
NUM_FRETS = 20

os.makedirs(OUT, exist_ok=True)
made = 0
for row, suffix in enumerate(ROWS):
    xml = open(f'{BASE}/annotation/{GUITAR}_{suffix}_fret_0-20.xml').read()
    events = []
    for ev in re.findall(r'<event>(.*?)</event>', xml, re.S):
        onset = float(re.search(r'<onsetSec>([\d.]+)</onsetSec>', ev).group(1))
        offset = float(re.search(r'<offsetSec>([\d.]+)</offsetSec>', ev).group(1))
        fret = int(re.search(r'<fretNumber>(\d+)</fretNumber>', ev).group(1))
        events.append((fret, onset, offset))
    events.sort(key=lambda e: e[1])

    w = wave.open(f'{BASE}/audio/{GUITAR}_{suffix}_fret_0-20.wav', 'rb')
    sr, sw, nch = w.getframerate(), w.getsampwidth(), w.getnchannels()
    assert nch == 1 and sw in (2, 3), (sw, nch)
    raw = w.readframes(w.getnframes()); w.close()
    if sw == 2:
        audio = struct.unpack(f'<{len(raw)//2}h', raw)
    else:  # 24-bit little-endian -> 16-bit
        n = len(raw) // 3
        audio = [int.from_bytes(raw[i*3:i*3+3], 'little', signed=True) >> 8 for i in range(n)]

    for i, (fret, onset, offset) in enumerate(events):
        if fret > NUM_FRETS: continue
        start = max(0, int((onset - 0.01) * sr))
        # end: annotated offset, but never past the next pluck
        end_t = offset
        if i + 1 < len(events):
            end_t = min(end_t, events[i+1][1] - 0.03)
        end = min(len(audio), int(end_t * sr))
        seg = list(audio[start:end])
        if len(seg) < sr // 10: continue
        peak = max(1, max(abs(x) for x in seg))
        gain = 0.85 * 32767 / peak
        fade = min(len(seg), int(sr * 0.05))
        for j in range(len(seg)):
            g = gain
            if j >= len(seg) - fade: g *= (len(seg) - j) / fade
            seg[j] = int(seg[j] * g)
        tmp = f'/tmp/seg_{row}_{fret}.wav'
        ww = wave.open(tmp, 'wb'); ww.setnchannels(1); ww.setsampwidth(2); ww.setframerate(sr)
        ww.writeframes(struct.pack(f'<{len(seg)}h', *seg)); ww.close()
        dst = f'{OUT}/{row}-{fret}.m4a'
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '96000', tmp, dst],
                       check=True, capture_output=True)
        os.remove(tmp)
        made += 1
print(f'{GUITAR}: wrote {made} samples')
