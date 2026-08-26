from __future__ import annotations

import json


def build_redirect_script(
    *,
    decrypt_rva: int,
    sample_name: str,
    artist_hint: str,
    title_hint: str,
    output_path: str,
) -> str:
    return f"""
const decryptRva = {decrypt_rva};
const sampleName = {json.dumps(sample_name, ensure_ascii=False)};
const artistHint = {json.dumps(artist_hint, ensure_ascii=False)};
const titleHint = {json.dumps(title_hint, ensure_ascii=False)};
const targetOutputPath = {json.dumps(output_path, ensure_ascii=False)};
let redirectDone = false;
let allocatedOutput = null;

function sendEvent(kind, payload) {{
  send(Object.assign({{ kind, ts: Date.now() / 1000 }}, payload || {{}}));
}}

function normalizeText(s) {{
  if (!s) return '';
  return String(s).toLowerCase().replace(/[_\\-]/g, ' ').replace(/\\s+/g, ' ').trim();
}}

function tryUtf16(ptr) {{
  try {{
    if (!ptr || ptr.isNull()) return null;
    const s = ptr.readUtf16String();
    if (!s || s.length === 0 || s.length > 520) return null;
    return s;
  }} catch (_) {{ return null; }}
}}

function safeReadPointer(ptr) {{
  try {{ return ptr.readPointer(); }} catch (_) {{ return null; }}
}}

function extractStringField(base, off) {{
  if (!base || base.isNull()) return null;
  try {{
    const slot = base.add(off);
    const p1 = safeReadPointer(slot);
    const s1 = tryUtf16(p1);
    if (s1) return s1;
    const direct = tryUtf16(slot);
    if (direct) return direct;
  }} catch (_) {{}}
  return null;
}}

function matchesSample(srcPath, outPath) {{
  const srcNorm = normalizeText(srcPath);
  const outNorm = normalizeText(outPath);
  const sampleNorm = normalizeText(sampleName);
  const titleNorm = normalizeText(titleHint);
  const artistNorm = normalizeText(artistHint);
  if (sampleNorm && (srcNorm.indexOf(sampleNorm) !== -1 || outNorm.indexOf(sampleNorm) !== -1)) return true;
  if (titleNorm && (srcNorm.indexOf(titleNorm) !== -1 || outNorm.indexOf(titleNorm) !== -1)) return true;
  if (artistNorm && (srcNorm.indexOf(artistNorm) !== -1 || outNorm.indexOf(artistNorm) !== -1)) return true;
  return false;
}}

const mod = Process.findModuleByName('QQMusic.dll');
if (!mod) {{
  sendEvent('fatal', {{ reason: 'QQMusic.dll not loaded' }});
}} else {{
  const fnAddr = mod.base.add(decryptRva);
  Interceptor.attach(fnAddr, {{
    onEnter(args) {{
      this.srcObj = args[0];
      this.outObj = args[1];
      this.srcPath = extractStringField(this.srcObj, 0x0);
      this.outPath = extractStringField(this.outObj, 0x0);
      this.coverPath = extractStringField(this.outObj, 0x4);
      if (!redirectDone && matchesSample(this.srcPath, this.outPath)) {{
        allocatedOutput = Memory.allocUtf16String(targetOutputPath);
        this.outObj.writePointer(allocatedOutput);
        redirectDone = true;
        this.redirected = true;
        sendEvent('redirect_applied', {{
          src_path: this.srcPath,
          original_output: this.outPath,
          new_output: targetOutputPath,
          cover_path: this.coverPath,
        }});
      }}
    }},
    onLeave(retval) {{
      if (this.redirected) {{
        sendEvent('redirect_result', {{
          retval: Number(retval.toUInt32()),
          src_path: this.srcPath,
          final_output: targetOutputPath,
          cover_path: this.coverPath,
        }});
      }}
    }}
  }});
}}
"""


def build_active_script(
    *,
    decrypt_rva: int,
    arg0_hex: str,
    arg1_hex: str,
    source_cache_path: str,
    output_path: str,
    cover_path: str,
) -> str:
    return f"""
const decryptRva = {decrypt_rva};
const arg0Hex = {json.dumps(arg0_hex)};
const arg1Hex = {json.dumps(arg1_hex)};
const sourceCachePath = {json.dumps(source_cache_path, ensure_ascii=False)};
const outputPath = {json.dumps(output_path, ensure_ascii=False)};
const coverPath = {json.dumps(cover_path, ensure_ascii=False)};

function sendEvent(kind, payload) {{
  send(Object.assign({{ kind, ts: Date.now() / 1000 }}, payload || {{}}));
}}

function hexToBytes(hex) {{
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {{
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }}
  return out;
}}

const mod = Process.findModuleByName('QQMusic.dll');
if (!mod) {{
  sendEvent('fatal', {{ reason: 'QQMusic.dll not loaded' }});
}} else {{
  const fnAddr = mod.base.add(decryptRva);
  const srcObj = Memory.alloc(arg0Hex.length / 2);
  const outObj = Memory.alloc(arg1Hex.length / 2);
  srcObj.writeByteArray(hexToBytes(arg0Hex));
  outObj.writeByteArray(hexToBytes(arg1Hex));
  srcObj.writePointer(Memory.allocUtf16String(sourceCachePath));
  outObj.writePointer(Memory.allocUtf16String(outputPath));
  outObj.add(4).writePointer(Memory.allocUtf16String(coverPath));
  try {{
    const fn = new NativeFunction(fnAddr, 'uint32', ['pointer', 'pointer'], 'stdcall');
    const rv = fn(srcObj, outObj);
    sendEvent('invoke_result', {{ retval: rv }});
  }} catch (e) {{
    sendEvent('invoke_error', {{ error: String(e) }});
  }}
}}
"""


__all__ = [
    "build_redirect_script",
    "build_active_script",
]
