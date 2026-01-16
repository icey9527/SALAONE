import os
import re

# txt 路径：相对“脚本所在目录”
TXT_PATH = r"data/RS/BOOT.txt"

PATTERNS = {
    "BG": re.compile(r'^\s*BG\s+\d+\s+"([^"]+)"\s*$'),
    "SE_PLAY": re.compile(r'^\s*SE_PLAY\s+"([^"]+)"\s*$'),
    "SOUND_PLAY_TOGGLE": re.compile(r'^\s*SOUND_PLAY_TOGGLE\s+"([^"]+)"\s*$'),
}

# 按指令自动补的后缀
EXT_BY_CMD = {
    "BG": ".png",
    "SE_PLAY": ".wav",
    "SOUND_PLAY_TOGGLE": ".wav",
}

def norm_rel(p: str) -> str:
    p = p.strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return os.path.normpath(p)

def exists_case_sensitive(path: str) -> bool:
    parent = os.path.dirname(path) or "."
    name = os.path.basename(path)
    if not os.path.isdir(parent):
        return False
    try:
        return name in os.listdir(parent)  # 精确匹配（大小写敏感比较）
    except OSError:
        return False

def ensure_ext(path: str, ext: str) -> str:
    # 如果已经带扩展名就不动；否则补上指定 ext
    root, cur_ext = os.path.splitext(path)
    return path if cur_ext else (path + ext)

def check_file(txt_abs_path: str):
    txt_dir = os.path.dirname(txt_abs_path)
    not_found = []

    with open(txt_abs_path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            raw = line.rstrip("\n")

            for cmd, pat in PATTERNS.items():
                m = pat.match(raw)
                if not m:
                    continue

                rel_raw = norm_rel(m.group(1))
                rel = ensure_ext(rel_raw, EXT_BY_CMD[cmd])

                abs_path = os.path.normpath(os.path.join(txt_dir, rel))

                ok = os.path.exists(abs_path) and exists_case_sensitive(abs_path)
                if not ok:
                    not_found.append((line_no, cmd, rel, abs_path, raw))
                break

    return not_found

if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    txt_abs = os.path.normpath(os.path.join(script_dir, TXT_PATH))

    if not os.path.isfile(txt_abs):
        print("TXT 文件没找到：")
        print("  TXT_PATH(相对脚本):", TXT_PATH)
        print("  脚本目录:", script_dir)
        print("  拼出的绝对路径:", txt_abs)
        raise SystemExit(1)

    missing = check_file(txt_abs)

    if not missing:
        print("全部找到（并且大小写匹配）。")
    else:
        print("没找到 / 大小写不匹配：")
        for line_no, cmd, rel, abs_path, raw in missing:
            print(f"[Line {line_no}] {cmd} -> '{rel}'")
            print(f"  解析行: {raw}")
            print(f"  绝对路径: {abs_path}")