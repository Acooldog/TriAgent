from __future__ import annotations
import logging
import os
import tempfile
import time
import frida
from src.Infrastructure.platforms.qq.runtime.qq_decryptor_main import Decryptor_main

logger = logging.getLogger("qqmusic_decrypt.manager")

def is_ascii_path(path: str) -> bool:
    try:
        path.encode("ascii")
        return True
    except Exception:
        return False

def pick_safe_tmp_dir(output_dir: str) -> str:
    abs_output_dir = os.path.abspath(output_dir) if output_dir else output_dir
    drive, _ = os.path.splitdrive(abs_output_dir)
    candidates = []
    if drive:
        candidates.append(os.path.join(drive + os.sep, "_qqmusic_tmp"))
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    candidates.append(os.path.join(project_root, "_qqmusic_tmp"))
    candidates.append(tempfile.gettempdir())
    for candidate in candidates:
        if not candidate or not is_ascii_path(candidate):
            continue
        try:
            os.makedirs(candidate, exist_ok=True)
            return candidate
        except Exception:
            continue
    logger.warning("未找到可用的ASCII临时目录，回退到输出目录: %s", output_dir)
    return output_dir

class QQMusicDecryptor:
    """QQ音乐解密器"""

    def __init__(self, session):
        self.session = session
        self.target_dll = "QQMusicCommon.dll"
        self.functions = {}
        self._initialize_functions()

    def _initialize_functions(self):
        logger.info("正在查找QQMusicCommon.dll...")
        script_code = """
        var targetModule = Process.findModuleByName("QQMusicCommon.dll");
        if (!targetModule) {
          send({ type: "error", message: "未找到QQMusicCommon.dll" });
        } else {
          send({ type: "found_module", base: targetModule.base.toString(), size: targetModule.size });
          var exports = targetModule.enumerateExports();
          var exportList = [];
          exports.forEach(function(exp) {
            if (exp.name.indexOf("EncAndDesMediaFile") !== -1) {
              exportList.push({ name: exp.name, address: exp.address.toString() });
            }
          });
          send({ type: "exports", data: exportList });
        }
        """
        script = self.session.create_script(script_code)
        module_info = {}
        export_functions = []
        def on_message(message, data):
            msg_type = message.get("type")
            if msg_type == "send":
                payload = message.get("payload", {})
                if payload.get('type') == 'found_module':
                    module_info['base'] = int(payload['base'], 16)
                    module_info['size'] = payload['size']
                elif payload.get('type') == 'exports':
                    for exp in payload['data']:
                        exp['address'] = int(exp['address'], 16)
                        export_functions.append(exp)
                elif payload.get("type") == "error":
                    logger.error("Frida模块枚举错误: %s", payload.get("message"))
                else:
                    logger.debug("Frida消息: %s", payload)
            elif msg_type == "error":
                logger.error("Frida脚本错误: %s", message.get("stack", message))
            else:
                logger.debug("Frida脚本消息: %s", message)
        script.on('message', on_message)
        script.load()
        time.sleep(0.5)
        if not module_info:
            raise RuntimeError(f"未找到{self.target_dll}")
        logger.info("找到%s @ %s", self.target_dll, hex(module_info['base']))
        logger.info("正在查找相关导出函数...")
        if not export_functions:
            raise RuntimeError("未找到任何EncAndDesMediaFile相关函数")
        logger.info("找到 %s 个相关函数", len(export_functions))
        possible_names = {
            'constructor': [
                "??0EncAndDesMediaFile@@QAE@XZ",
                "??0EncAndDesMediaFile@@QEAA@XZ",
                "??0EncAndDesMediaFile@@IAAE@XZ"
            ],
            'destructor': [
                "??1EncAndDesMediaFile@@QAE@XZ",
                "??1EncAndDesMediaFile@@QEAA@XZ",
                "??1EncAndDesMediaFile@@IAAE@XZ"
            ],
            'open': [
                "?Open@EncAndDesMediaFile@@QAE_NPB_W_N1@Z",
                "?Open@EncAndDesMediaFile@@QEAA_NPEB_W_N1@Z"
            ],
            'getSize': [
                "?GetSize@EncAndDesMediaFile@@QAEKXZ",
                "?GetSize@EncAndDesMediaFile@@QEAAKXZ"
            ],
            'read': [
                "?Read@EncAndDesMediaFile@@QAEKPAEK_J@Z",
                "?Read@EncAndDesMediaFile@@QEAAKPEAEK_J@Z"
            ]
        }
        for exp in export_functions:
            name = exp['name']
            address = exp['address']
            if 'constructor' not in self.functions:
                for possible_name in possible_names['constructor']:
                    if name == possible_name:
                        self.functions['constructor'] = address
                        logger.info("找到构造函数: %s @ %s", name, hex(address))
                        break
            if 'destructor' not in self.functions:
                for possible_name in possible_names['destructor']:
                    if name == possible_name:
                        self.functions['destructor'] = address
                        logger.info("找到析构函数: %s @ %s", name, hex(address))
                        break
            if 'open' not in self.functions:
                for possible_name in possible_names['open']:
                    if name == possible_name:
                        self.functions['open'] = address
                        logger.info("找到Open函数: %s @ %s", name, hex(address))
                        break
            if 'getSize' not in self.functions:
                for possible_name in possible_names['getSize']:
                    if name == possible_name:
                        self.functions['getSize'] = address
                        logger.info("找到GetSize函数: %s @ %s", name, hex(address))
                        break
            if 'read' not in self.functions:
                for possible_name in possible_names['read']:
                    if name == possible_name:
                        self.functions['read'] = address
                        logger.info("找到Read函数: %s @ %s", name, hex(address))
                        break
        required = ['constructor', 'destructor', 'open', 'getSize', 'read']
        missing = [f for f in required if f not in self.functions]
        if missing:
            raise RuntimeError(f"未找到所有必要的函数: {', '.join(missing)}")
        logger.info("所有函数都已找到！")
        logger.info("创建解密脚本...")
        self._create_decrypt_script()

    def _create_decrypt_script(self):
        script_code = f"""
        var constructorAddr = ptr("{hex(self.functions['constructor'])}");
        var destructorAddr = ptr("{hex(self.functions['destructor'])}");
        var openAddr = ptr("{hex(self.functions['open'])}");
        var getSizeAddr = ptr("{hex(self.functions['getSize'])}");
        var readAddr = ptr("{hex(self.functions['read'])}");
        var Constructor = new NativeFunction(constructorAddr, "pointer", ["pointer"], "thiscall");
        var Destructor = new NativeFunction(destructorAddr, "void", ["pointer"], "thiscall");
        var Open = new NativeFunction(openAddr, "bool", ["pointer", "pointer", "bool", "bool"], "thiscall");
        var GetSize = new NativeFunction(getSizeAddr, "uint32", ["pointer"], "thiscall");
        var Read = new NativeFunction(readAddr, "uint", ["pointer", "pointer", "uint32", "uint64"], "thiscall");
        rpc.exports = {{
          decrypt: function (srcFileName, tmpFileName) {{
            try {{
              console.log("开始解密: " + srcFileName);
              var obj = Memory.alloc(0x28);
              Constructor(obj);
              var fileNameUtf16 = Memory.allocUtf16String(srcFileName);
              var openResult = Open(obj, fileNameUtf16, 1, 0);
              console.log("打开文件结果: " + openResult);
              var fileSize = GetSize(obj);
              console.log("文件大小: " + fileSize + " 字节");
              var buffer = Memory.alloc(fileSize);
              var readResult = Read(obj, buffer, fileSize, 0);
              console.log("读取字节数: " + readResult);
              var data = buffer.readByteArray(fileSize);
              Destructor(obj);
              var tmpFile = new File(tmpFileName, "wb");
              tmpFile.write(data);
              tmpFile.close();
              console.log("解密完成: " + tmpFileName);
              return true;
            }} catch (e) {{
              console.log("解密出错: " + e);
              console.log("错误堆栈: " + e.stack);
              return false;
            }}
          }}
        }};
        console.log("解密脚本已加载");
        """
        self.decrypt_script = self.session.create_script(script_code)
        def on_message(message, data):
            msg_type = message.get("type")
            if msg_type == "send":
                logger.info("[Frida] %s", message.get("payload"))
            elif msg_type == "error":
                logger.error("[Frida] %s", message.get("stack", message))
            elif msg_type == "log":
                logger.info("[Frida/log] %s", message.get("payload"))
            else:
                logger.debug("[Frida/other] %s", message)
        self.decrypt_script.on("message", on_message)
        self.decrypt_script.load()
        logger.info("解密脚本加载成功！")

    def decrypt(self, src_file, dest_file):
        try:
            result = self.decrypt_script.exports_sync.decrypt(src_file, dest_file)
            return result
        except Exception:
            logger.exception("解密出错: src=%s, dest=%s", src_file, dest_file)
            return False

__all__ = [
    "QQMusicDecryptor",
    "Decryptor_main",
    "is_ascii_path",
    "pick_safe_tmp_dir",
]
