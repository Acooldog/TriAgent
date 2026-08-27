from __future__ import annotations

import pathlib
import struct
import subprocess
import tempfile

KGM_MAGIC = bytes.fromhex("7cd532eb86027f4ba8afa68e0fff9914")
TABLE1 = bytes.fromhex("000000000000000000000000000000000001210161012101e101210161012101d223020242420202c2c2020242420202d3d3020363436303e3c3e3036343630394b494650404040484848484040404049595959504052505e585a585e5052505d6b696b6d6270606c6c68686c6c60606d7d79797d7d70607e7c7e787e7c7e70718381878183818e9080808080808080819191919191919190809290969092909da3a1a3a5a3a1a3ada2b0a0a4a4a0a0adbdb1b1b5b5b1b1bdbdb0a0b6b4b6b0b9cbc9c7c1c3c1c7c9cbc9c6d0c0c0c0c9d9d9d9d1d1d1d1d9d9d9d9d0c0d2d0ddebe9ebede3e1e3edebe9ebede2f0e0edfdf9f9fdfdf1f1fdfdf9f9fdfdf0e0f00200060002000e000200060002000f1")
TABLE2 = bytes.fromhex("000000000000000000000000000000000001230167012301ef01230167012301df21020246460202cece020246460202dede020365476503edcfed03654765039dbf9d63040404048c8c8c8c040404049c9c9c9c04052705eb8daf8deb052705dbbd9fbddb250606caca8e8ecaca0606dada9e9edada0607e9cbe98fe9cbe907193b197f193b19e70808080808080808181818181818181808092b096f092b09d7391b395f391b39d7290a0a4e4e0a0ad6d61a1a5e5e1a1ad6d60a0b6d4f6d0b95b7957b1d3f1d7b95b7956b0c0c0c0c949494941c1c1c1c949494940c0d2f0dd3b597b5d33d1f3dd3b597b5d32d0e0ed2d29696d2d21e1ed2d29696d2d20e0f00220066002200ee00220066002200fe")
MASK = bytes.fromhex("b8d53db2e9af788c8333715176a0cd372f3e358da9be98b7e78c22ce5a61df686989fea5b6dea977fcc8bdbde56d3e5a36ef694ebee1e9661cf3d902b6f2129b44d06fb93589b6466d73820669c1edd785c230dfa262be792d62623d0d7ebe48892302a0e4d57551320253fd163a213b160fc3b2bbb3e2ba3a3d13ecf6014584a5700f93490c64cd31d5cc4c07019e001a2390bf881e3baba63ec47347107e3b5ebce30084ff09d4e0890f5b58704ffb65d85c531bd3c8c6bfef98b0504f0feae583588c282c8467cdd09e47db2750caf46363e8977f1b4b0cc2c1214ccc58f59452a3f3d3e068f40023f35e0a7b93ddab12b213e884d7a79f0f324c551d043652dc03f3f94e42e93d61ef7cb6b39350")


def unlock_mask(position: int) -> int:
    offset = position >> 4
    value = 0
    while offset >= 0x11:
        value ^= TABLE1[offset % 272]
        offset >>= 4
        value ^= TABLE2[offset % 272]
        offset >>= 4
    return MASK[position % 272] ^ value


def encrypt_unlock_music(plain: bytes, own_key: bytes) -> bytes:
    encrypted = bytearray(len(plain))
    for position, value in enumerate(plain):
        mask = unlock_mask(position)
        mask ^= (mask & 0x0F) << 4
        transformed = value ^ mask
        transformed ^= (transformed & 0x0F) << 4
        encrypted[position] = transformed ^ own_key[position % 17]
    return bytes(encrypted)


def generate(output: pathlib.Path, public_key_path: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory(prefix="trimusic-sample-") as temp:
        mp3 = pathlib.Path(temp) / "sample.mp3"
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-q:a", "9", str(mp3)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        own_key = bytes(range(16)) + b"\x00"
        payload = encrypt_unlock_music(mp3.read_bytes(), own_key)
        header = bytearray(1024)
        header[:16] = KGM_MAGIC
        struct.pack_into("<III", header, 0x10, 1024, 3, 0)
        header[0x1C:0x2C] = own_key[:16]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(bytes(header) + payload)


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parents[3]
    generate(root / "desktop" / "tests" / "fixtures" / "sample.kgm", root / "assets" / "kugou_key.xz")
