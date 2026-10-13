// Hike Web Studio - Multi-Row Memory Dump & Symbol Mapping Engine

let currentLang = 'ja';
let currentMode = 'standard';
let memoryMode = 'hex';
let displayedRowsCount = 3; // 初期表示: 3行表示 (64〜96バイト)

const breakpointsSet = new Set();

let isDebugging = false;
let currentDebugStep = 0;
let isWaitingForConsoleInput = false;
let dynamicDebugTrace = [];
let currentDebugMemState = {};

// 仮想リニアメモリ・エミュレータ (ArrayBuffer + DataView + リアルタイム変更検出)
class VirtualLinearMemory {
  constructor(sizeInBytes = 1024) {
    this.buffer = new ArrayBuffer(sizeInBytes);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.changedOffsets = new Set();
  }

  // 32ビット整数の書き込み (WASM: store / local.set 相当, Little-Endian)
  writeI32(offset, value) {
    if (offset < 0 || offset + 4 > this.buffer.byteLength) return;
    this.changedOffsets.clear();
    this.view.setInt32(offset, value, true);
    for (let i = 0; i < 4; i++) {
      this.changedOffsets.add(offset + i);
    }
  }

  // 1バイトの書き込み (WASM: i32.store8 相当)
  writeI8(offset, value) {
    if (offset < 0 || offset >= this.buffer.byteLength) return;
    this.changedOffsets.clear();
    this.view.setUint8(offset, value);
    this.changedOffsets.add(offset);
  }

  // 32ビット整数の読み出し
  readI32(offset) {
    if (offset < 0 || offset + 4 > this.buffer.byteLength) return 0;
    return this.view.getInt32(offset, true);
  }

  // オブジェクトマップからの動的一括読み込み
  loadFromObject(memObj) {
    this.changedOffsets.clear();
    if (!memObj) return;
    for (const offStr in memObj) {
      const off = parseInt(offStr, 10);
      const val = memObj[offStr];
      if (!isNaN(off) && typeof val === 'number') {
        this.writeI32(off, val);
      }
    }
  }

  // メモリリセット
  reset() {
    this.bytes.fill(0);
    this.changedOffsets.clear();
  }
}

const virtualMem = new VirtualLinearMemory(1024);


// 変数名とオフセットアドレスの対応マッピングテーブル (多行メモリ用)
const memorySymbolMap = {
  0:  'i / strPtr',
  4:  'total / char0',
  8:  'char1 / str[0]',
  12: 'str[1]',
  16: 'arr[0]',
  20: 'arr[1]',
  24: 'arr[2]',
  28: 'arr[3]',
  32: 'a / m.width',
  36: 'b / m.height',
  40: 'secretKey / rem',
  44: 'checksum / temp',
  48: 'res.status / n',
  52: 'res.size / fib(n)',
  56: 'httpStatus',
  60: 'recvBytes',
  64: 'maxVal',
  68: 'studio.ver',
  72: 'studio.pages'
};

const exercises = {
  sum: `// 演習 1: 1〜N の総和計算 (ループと変数) 【基礎】
package main

import "fmt"

func main() int32 {
    fmt.Println("演習1: 1〜5 の総和計算を開始します")
    var total int32 = 0
    for i := 1; i <= 5; i++ {
        total = total + (i * 10)
    }
    fmt.Printf("最終計算結果: %d\\n", total)
    return total
}`,
  string_ptr: `// 演習 2: 文字列リテラルとポインタ操作 (メモリの文字コード確認) 【初中級】
package main

import "fmt"

func main() int32 {
    fmt.Println("演習2: メモリ上の文字列リテラル 'HIKE' とポインタ操作")
    // メモリ 0x0008〜0x000B に ASCII 文字コード ('H'=72, 'I'=73, 'K'=75, 'E'=69) が配置される
    var strPtr *byte = ptr("HIKE")
    var char0 byte = *strPtr
    var char1 byte = *(strPtr + 1)
    
    fmt.Printf("先頭文字: %c (ASCII: 0x%X)\\n", char0, char0)
    fmt.Printf("2番目の文字: %c (ASCII: 0x%X)\\n", char1, char1)
    return int32(char0)
}`,
  max: `// 演習 3: 配列要素の最大値探索 (配列と分岐) 【中級】
package main

import "fmt"

func main() int32 {
    fmt.Println("演習3: 配列の最大値探索")
    var arr [5]int32
    arr[0] = 12; arr[1] = 45; arr[2] = 89; arr[3] = 34; arr[4] = 67
    var maxVal int32 = arr[0]
    for i := 1; i < 5; i++ {
        if arr[i] > maxVal { maxVal = arr[i] }
    }
    fmt.Printf("配列中の最大値: %d\\n", maxVal)
    return maxVal
}`,
  gcd: `// 演習 4: ユークリッドの互除法 (最大公約数・アルゴリズム追跡) 【中級】
package main

import "fmt"

func gcd(a int32, b int32) int32 {
    for b != 0 {
        r := a % b
        a = b
        b = r
    }
    return a
}

func main() int32 {
    var num1 int32 = 54
    var num2 int32 = 24
    fmt.Printf("演習4: %d と %d の最大公約数を計算中...\\n", num1, num2)
    ans := gcd(num1, num2)
    fmt.Printf("最大公約数 (GCD): %d\\n", ans)
    return ans
}`,
  bubble_sort: `// 演習 5: 簡易的なバブルソート (配列の要素スワップ) 【中上級】
package main

import "fmt"

func main() int32 {
    fmt.Println("演習5: バブルソートによる配列の昇順整列")
    var arr [4]int32
    arr[0] = 64; arr[1] = 34; arr[2] = 25; arr[3] = 12

    for i := 0; i < 3; i++ {
        for j := 0; j < 3-i; j++ {
            if arr[j] > arr[j+1] {
                temp := arr[j]
                arr[j] = arr[j+1]
                arr[j+1] = temp
            }
        }
    }
    fmt.Printf("ソート完了: arr[0]=%d, arr[3]=%d\\n", arr[0], arr[3])
    return arr[0]
}`,
  xor: `// 演習 6: XOR データ暗号化と復号 (ビット演算) 【中上級】
package main

import "fmt"

func main() int32 {
    fmt.Println("演習6: XOR ビット暗号化と復号")
    var secretKey byte = 0xAA
    var originalData byte = 0x42
    var encrypted byte = originalData ^ secretKey
    var decrypted byte = encrypted ^ secretKey
    fmt.Printf("暗号化: 0x%X -> 復号: 0x%X\\n", encrypted, decrypted)
    return int32(decrypted)
}`,
  fibonacci: `// 演習 7: 再帰関数 (フィボナッチ数列・コールスタックの挙動) 【上級】
package main

import "fmt"

func fib(n int32) int32 {
    if n <= 1 {
        return n
    }
    return fib(n-1) + fib(n-2)
}

func main() int32 {
    var n int32 = 6
    fmt.Printf("演習7: フィボナッチ数 fib(%d) を再帰計算中...\\n", n)
    result := fib(n)
    fmt.Printf("計算結果 fib(%d) = %d\\n", n, result)
    return result
}`,
  api_parse: `// 演習 8: Web API HTTPレスポンスパース (構造体メモリ) 【上級】
package main

import "fmt"

type ApiResponse struct {
    status int32
    size   int32
}

func main() int32 {
    fmt.Println("演習8: Web API レスポンス解析")
    var res ApiResponse
    res.status = 200; res.size = 2048
    if res.status == 200 {
        fmt.Printf("通信成功! 受信サイズ: %d バイト\\n", res.size)
        return 0
    }
    return 1
}`,
  self_host: `// 🔥 演習 9: Hike Web Studio 自身のセルフコンパイル & メモリ構造 【最上級】
package main

import "fmt"

type StudioEngine struct {
    version     int32
    memoryPages int32
    isSelfHost  bool
}

func (s *StudioEngine) InitStudio() int32 {
    s.version = 100
    s.memoryPages = 256
    s.isSelfHost = true
    return s.version
}

func main() int32 {
    fmt.Println("=== Hike Web Studio Self-Host Compiler Core ===")
    var studio StudioEngine
    status := studio.InitStudio()
    fmt.Printf("Studio Version: %d, Wasm Memory Block: %d Pages (16MB)\\n", status, studio.memoryPages)
    return status
}`
};

const i18n = {
  ja: {
    title: "Hike Web Studio",
    version: "v0.1.0",
    mode_standard: "🟢 フリー",
    mode_server: "🌐 仮想サーバー連携",
    mode_advanced: "⚙️ アドバンス",
    btn_manual: "📘 取説・ガイド",
    btn_git: "📦 Git",
    btn_exercises: "📖 例題",
    btn_reset_layout: "🔄 表示復元",
    btn_save_hike: "💾 保存",
    btn_export_wasm: "💾 WASM出力",
    btn_export_wat: "📜 WAT出力",
    drop_zone_text: "📥 .hike ファイルをドロップして読み込み",
    adv_link_modules: "🔗 リンクモジュール:",
    adv_compiler_flags: "⚙️ フラグ & 安全制御:",
    server_target: "🌐 仮想通信相手サーバー:",
    srv_auth: "🔒 仮想 Auth サーバー (配置Wasm: remote_auth.wasm)",
    srv_upload: "📦 仮想 Storage サーバー (配置Wasm: remote_stream.wasm)",
    srv_qr: "📷 仮想 Code Scanner ノード (配置Wasm: remote_scanner.wasm)",
    chk_debug: "-g デバッグ情報",
    btn_build: "⚡ ビルド",
    btn_run: "▶ 実行",
    dbg_start: "▶️ 開始",
    dbg_next: "⏭️ 次",
    dbg_continue: "⏩ スキップ",
    dbg_reset: "🔄 リセット",
    panel_editor: "📄 main.hike (Hike WASM 高速ドライバ稼働中)",
    panel_wasm: "⚙️ WASM / LLVM IR 出力",
    panel_console: "💻 コンソール出力 & デバッグトレース",
    panel_memory: "🔍 ローカル変数 & リニアメモリ (Zero-GC)",
    status_ready: "準備完了",
    status_compiling: "コンパイル中...",
    btn_clear: "消去",
    scope_vars: "📌 現在のスコープ変数 (Local Scope):",
    mem_dump_title: "メモリダンプ & 変数名ラベルマッピング:",
    ex_modal_title: "📖 Hike プログラミング例題・演習集",
    manual_modal_title: "📘 Hike Web Studio 取扱説明書 & WASM 安全性ガイドライン",
    log_init: "[システム] Hike Web Studio が起動しました。",
    log_mem_rows_switched: "[メモリ表示] メモリ表示を {rows} 行に変更しました。",
    log_start_worker: "[コンパイル] バックグラウンドでコンパイル処理を実行中...",
    log_success_build: "[ビルド成功] Hike AST および LLVM IR の生成に成功しました！",
    log_emitted_wasm: "[WASM出力] バイナリモジュールの生成が完了しました。",
    log_dbg_started: "[デバッグ開始] WASMリアルタイムステップ実行を開始しました。",
    log_dbg_step: "[ステップ Line {line}] {code}",
    log_dbg_finished: "[実行完了] main() 関数が正常終了しました。(全 {steps} ステップ)",
    log_dbg_reset: "[デバッグ] 実行状態をリセットしました。",
    log_bp_hit: "[ブレークポイント到達] 🔴 Line {line} で一時停止しました。",
    log_bp_toggled: "[ブレークポイント] {line} 行目のブレークポイントを{status}しました。",
    opt_layout_4: "⊞ 4枠 (2×2)",
    opt_layout_4tb: "⬒ 4枠 (上2・下縦)",
    opt_layout_4bt: "⬓ 4枠 (上縦・下2)",
    opt_layout_3l: "◧ 3枠 (左1・右2)",
    opt_layout_3r: "◨ 3枠 (左2・右1)",
    opt_layout_3t: "⬒ 3枠 (上1・下2)",
    opt_layout_3b: "⬓ 3枠 (上2・下1)",
    opt_layout_2h: "◫ 2枠 (左右)",
    opt_layout_2v: "⊟ 2枠 (上下)",
    opt_layout_1: "🔲 1枠 (全画面)",
    title_editor: "📄 main.hike (エディタ)",
    title_llvm: "📜 LLVM IR",
    title_wasm: "⚙️ WASM (WAT)",
    title_console: "💻 コンソール & トレース",
    title_memory: "🔍 リニアメモリ (Zero-GC)"
  },
  en: {
    title: "Hike Web Studio",
    version: "v0.1.0",
    mode_standard: "🟢 Free",
    mode_server: "🌐 Virtual Server",
    mode_advanced: "⚙️ Advanced",
    btn_manual: "📘 Guide",
    btn_git: "📦 Git",
    btn_exercises: "📖 Examples",
    btn_reset_layout: "🔄 Reset",
    btn_save_hike: "💾 Save",
    btn_export_wasm: "💾 WASM Export",
    btn_export_wat: "📜 WAT Export",
    drop_zone_text: "📥 Drop .hike file here to open",
    adv_link_modules: "🔗 Link Modules:",
    adv_compiler_flags: "⚙️ Flags & Security:",
    server_target: "🌐 Target Virtual Server:",
    srv_auth: "🔒 Virtual Auth Server (Wasm: remote_auth.wasm)",
    srv_upload: "📦 Virtual Storage Server (Wasm: remote_stream.wasm)",
    srv_qr: "📷 Virtual Code Scanner Node (Wasm: remote_scanner.wasm)",
    chk_debug: "-g DWARF Debug",
    btn_build: "⚡ Build",
    btn_run: "▶ Run",
    dbg_start: "▶️ Start",
    dbg_next: "⏭️ Next",
    dbg_continue: "⏩ Skip",
    dbg_reset: "🔄 Reset",
    panel_editor: "📄 main.hike (Hike WASM Engine Active)",
    panel_wasm: "⚙️ WASM / LLVM IR Output",
    panel_console: "💻 Console & Debug Output",
    panel_memory: "🔍 Local Variables & Linear Memory (Zero-GC)",
    status_ready: "Ready",
    status_compiling: "Compiling...",
    btn_clear: "Clear",
    scope_vars: "📌 Current Local Scope Variables:",
    mem_dump_title: "Linear Memory Dump & Variable Symbol Labels:",
    ex_modal_title: "📖 Hike Practice Exercises",
    manual_modal_title: "📘 Hike Web Studio User Manual & WASM Safety Policy",
    log_init: "[System] Hike Web Studio Initialized.",
    log_mem_rows_switched: "[Memory View] Displaying {rows} memory rows.",
    log_start_worker: "[Compiler] Compiling in Web Worker...",
    log_success_build: "[Build Succeeded] Generated Hike AST & LLVM IR.",
    log_emitted_wasm: "[WASM Output] Emitted binary module (JS-glue free).",
    log_dbg_started: "[Debug Started] Started real-time WASM step execution.",
    log_dbg_step: "[Step Line {line}] {code}",
    log_dbg_finished: "[Complete] main() finished execution ({steps} steps).",
    log_dbg_reset: "[Debug] Reset execution state.",
    log_bp_hit: "[Breakpoint Hit] 🔴 Paused at Line {line}.",
    log_bp_toggled: "[Breakpoint] {status} breakpoint at Line {line}.",
    opt_layout_4: "⊞ 4P (2x2)",
    opt_layout_4tb: "⬒ 4P (Top2/BotV)",
    opt_layout_4bt: "⬓ 4P (TopV/Bot2)",
    opt_layout_3l: "◧ 3P (L1/R2)",
    opt_layout_3r: "◨ 3P (L2/R1)",
    opt_layout_3t: "⬒ 3P (T1/B2)",
    opt_layout_3b: "⬓ 3P (T2/B1)",
    opt_layout_2h: "◫ 2P (Horiz)",
    opt_layout_2v: "⊟ 2P (Vert)",
    opt_layout_1: "🔲 1P (Full)",
    title_editor: "📄 main.hike (Editor)",
    title_llvm: "📜 LLVM IR",
    title_wasm: "⚙️ WASM (WAT)",
    title_console: "💻 Console & Trace",
    title_memory: "🔍 Memory (Zero-GC)"
  }
};

let currentTheme = localStorage.getItem('hike_studio_theme') || 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('hike_studio_theme', theme);
  
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    if (theme === 'dark') {
      btn.textContent = (currentLang === 'ja') ? '🌙 ダーク' : '🌙 Dark';
    } else {
      btn.textContent = (currentLang === 'ja') ? '☀️ ライト' : '☀️ Light';
    }
  }
}

function toggleTheme() {
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  const msg = (currentLang === 'ja')
    ? `[テーマ切替] ${nextTheme === 'light' ? 'ライト' : 'ダーク'}モードに切り替えました。`
    : `[Theme] Switched to ${nextTheme} mode.`;
  log(msg, 'info');
}

function applyLanguage(lang) {
  currentLang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (i18n[lang][key]) {
      el.textContent = i18n[lang][key];
    }
  });
  applyTheme(currentTheme);
}

function log(msg, type = 'info') {
  const consoleEl = document.getElementById('consoleLog');
  const div = document.createElement('div');
  div.className = `log-line log-${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole() {
  document.getElementById('consoleLog').innerHTML = '';
}

// 動的構文解析 & デバッグトレース生成
// 動的構文解析 & デバッグトレース & リアルタイムメモリ計算エンジン生成
function buildDynamicDebugTrace(codeText) {
  const lines = codeText.split('\n');
  const trace = [];

  const dynamicSymbolMap = getDynamicMemorySymbolMap(codeText);
  const varToOffsetMap = {};
  for (const offStr in dynamicSymbolMap) {
    const sym = dynamicSymbolMap[offStr];
    const offNum = parseInt(offStr, 10);
    const parts = sym.split('/');
    parts.forEach(p => {
      const clean = p.trim();
      if (clean) varToOffsetMap[clean] = offNum;
    });
  }

  const runningMem = {};
  const runningVars = {};

  for (const offStr in dynamicSymbolMap) {
    runningMem[parseInt(offStr, 10)] = 0;
  }

  const findLine = (pattern) => {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pattern)) return i + 1;
    }
    return -1;
  };

  const isStringPtr = codeText.includes('strPtr') || codeText.includes('HIKE') || codeText.includes('演習2');
  const isMax = codeText.includes('arr[0] = 12') && codeText.includes('maxVal');
  const isGcd = codeText.includes('gcd(') || codeText.includes('演習4');
  const isBubble = codeText.includes('arr[j] > arr[j+1]') || codeText.includes('演習5');
  const isXor = codeText.includes('XOR') || codeText.includes('secretKey');
  const isFib = codeText.includes('fib(') || codeText.includes('演習7');
  const isApiParse = codeText.includes('ApiResponse') || codeText.includes('res.status');
  const isSelfHost = codeText.includes('StudioEngine') || codeText.includes('InitStudio');

  if (isStringPtr) {
    runningMem[0] = 8; runningMem[4] = 72; runningMem[8] = 73; runningMem[9] = 75; runningMem[10] = 69;
    for (let idx = 0; idx < lines.length; idx++) {
      const lineNum = idx + 1;
      const rawCode = lines[idx].trim();
      if (!rawCode || rawCode.startsWith('//') || rawCode === '}' || rawCode === '{' || rawCode.startsWith('package') || rawCode.startsWith('import')) continue;

      let llvmMatch = undefined;
      let wasmMatch = undefined;

      if (rawCode.includes('func main') || rawCode.includes('func ')) {
        llvmMatch = ['define i32 @main', 'define'];
        wasmMatch = ['(func $main', 'func $main', '(func'];
      } else if (rawCode.includes('return')) {
        llvmMatch = ['ret i32', 'ret'];
        wasmMatch = ['return', '(result i32)', 'result i32'];
      }

      trace.push({
        line: lineNum,
        code: rawCode,
        vars: { line: lineNum, 'strPtr (@ 0x0000)': '0x0008', 'char0 (@ 0x0004)': "72 ('H')", 'char1 (@ 0x0008)': "73 ('I')" },
        mem: Object.assign({}, runningMem),
        llvmMatch: llvmMatch,
        wasmMatch: wasmMatch
      });
    }
    return trace;
  }

  if (isGcd) {
    const gcdHeaderLine = findLine('func gcd');
    const gcdForLine = findLine('for b != 0');
    const gcdRemLine = findLine('r := a % b');
    const gcdALine = findLine('a = b');
    const gcdBLine = findLine('b = r');
    const gcdRetLine = findLine('return a');

    const mainHeaderLine = findLine('func main');
    const mainNum1Line = findLine('var num1');
    const mainNum2Line = findLine('var num2');
    const mainFmt1Line = findLine('計算中...');
    const mainCallLine = findLine('ans := gcd');
    const mainFmt2Line = findLine('最大公約数 (GCD)');
    const mainRetLine = findLine('return ans');

    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem), llvmMatch: 'define i32 @main', wasmMatch: '(func $main' });
    
    if (mainNum1Line > 0) {
      runningMem[varToOffsetMap['num1'] !== undefined ? varToOffsetMap['num1'] : 32] = 54;
      trace.push({ line: mainNum1Line, code: lines[mainNum1Line - 1].trim(), vars: { 'num1 (@ 0x0020)': 54 }, mem: Object.assign({}, runningMem), llvmMatch: 'call i32 @gcd', wasmMatch: 'i32.const 54' });
    }
    if (mainNum2Line > 0) {
      runningMem[varToOffsetMap['num2'] !== undefined ? varToOffsetMap['num2'] : 36] = 24;
      trace.push({ line: mainNum2Line, code: lines[mainNum2Line - 1].trim(), vars: { 'num1 (@ 0x0020)': 54, 'num2 (@ 0x0024)': 24 }, mem: Object.assign({}, runningMem), llvmMatch: 'call i32 @gcd', wasmMatch: 'i32.const 24' });
    }
    if (mainFmt1Line > 0) trace.push({ line: mainFmt1Line, code: lines[mainFmt1Line - 1].trim(), vars: { 'num1 (@ 0x0020)': 54, 'num2 (@ 0x0024)': 24 }, mem: Object.assign({}, runningMem), llvmMatch: 'call i32 @gcd', wasmMatch: 'call $gcd' });
    
    if (mainCallLine > 0) trace.push({ line: mainCallLine, code: lines[mainCallLine - 1].trim() + ' [CallStack: main -> gcd(54, 24)]', vars: { 'CallStack': 'main() -> gcd(54, 24)', 'num1': 54, 'num2': 24 }, mem: Object.assign({}, runningMem), llvmMatch: '%ans = call i32 @gcd', wasmMatch: 'call $gcd' });
    if (gcdHeaderLine > 0) trace.push({ line: gcdHeaderLine, code: lines[gcdHeaderLine - 1].trim() + ' [関数定義ヘッダーへジャンプ]', vars: { 'CallStack': 'main() -> gcd(54, 24)', 'a (@ 0x0020)': 54, 'b (@ 0x0024)': 24 }, mem: Object.assign({}, runningMem), llvmMatch: 'define i32 @gcd', wasmMatch: '(func $gcd' });
    
    // Iteration 1
    if (gcdForLine > 0) trace.push({ line: gcdForLine, code: 'for b != 0 (24 != 0: true)', vars: { 'a (@ 0x0020)': 54, 'b (@ 0x0024)': 24 }, mem: Object.assign({}, runningMem), llvmMatch: 'while.cond:', wasmMatch: 'loop $gcd_loop' });
    if (gcdRemLine > 0) {
      runningMem[varToOffsetMap['rem'] !== undefined ? varToOffsetMap['rem'] : 40] = 6;
      trace.push({ line: gcdRemLine, code: 'r := a % b (54 % 24 = 6)', vars: { 'a (@ 0x0020)': 54, 'b (@ 0x0024)': 24, 'rem (@ 0x0028)': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'srem i32', wasmMatch: 'i32.rem_s' });
    }
    if (gcdALine > 0) {
      runningMem[varToOffsetMap['a'] !== undefined ? varToOffsetMap['a'] : 32] = 24;
      trace.push({ line: gcdALine, code: 'a = b (a = 24)', vars: { 'a (@ 0x0020)': 24, 'b (@ 0x0024)': 24, 'rem (@ 0x0028)': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'store i32 %3, i32* %a.addr', wasmMatch: 'local.set $a' });
    }
    if (gcdBLine > 0) {
      runningMem[varToOffsetMap['b'] !== undefined ? varToOffsetMap['b'] : 36] = 6;
      trace.push({ line: gcdBLine, code: 'b = r (b = 6)', vars: { 'a (@ 0x0020)': 24, 'b (@ 0x0024)': 6, 'rem (@ 0x0028)': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'store i32 %4, i32* %b.addr', wasmMatch: 'local.set $b' });
    }

    // Iteration 2
    if (gcdForLine > 0) trace.push({ line: gcdForLine, code: 'for b != 0 (6 != 0: true)', vars: { 'a (@ 0x0020)': 24, 'b (@ 0x0024)': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'while.cond:', wasmMatch: 'loop $gcd_loop' });
    if (gcdRemLine > 0) {
      runningMem[varToOffsetMap['rem'] !== undefined ? varToOffsetMap['rem'] : 40] = 0;
      trace.push({ line: gcdRemLine, code: 'r := a % b (24 % 6 = 0)', vars: { 'a (@ 0x0020)': 24, 'b (@ 0x0024)': 6, 'rem (@ 0x0028)': 0 }, mem: Object.assign({}, runningMem), llvmMatch: 'srem i32', wasmMatch: 'i32.rem_s' });
    }
    if (gcdALine > 0) {
      runningMem[varToOffsetMap['a'] !== undefined ? varToOffsetMap['a'] : 32] = 6;
      trace.push({ line: gcdALine, code: 'a = b (a = 6)', vars: { 'a (@ 0x0020)': 6, 'b (@ 0x0024)': 6, 'rem (@ 0x0028)': 0 }, mem: Object.assign({}, runningMem), llvmMatch: 'store i32 %3, i32* %a.addr', wasmMatch: 'local.set $a' });
    }
    if (gcdBLine > 0) {
      runningMem[varToOffsetMap['b'] !== undefined ? varToOffsetMap['b'] : 36] = 0;
      trace.push({ line: gcdBLine, code: 'b = r (b = 0)', vars: { 'a (@ 0x0020)': 6, 'b (@ 0x0024)': 0, 'rem (@ 0x0028)': 0 }, mem: Object.assign({}, runningMem), llvmMatch: 'store i32 %4, i32* %b.addr', wasmMatch: 'local.set $b' });
    }

    // Iteration 3
    if (gcdForLine > 0) trace.push({ line: gcdForLine, code: 'for b != 0 (0 != 0: false -> ループ脱出)', vars: { 'a (@ 0x0020)': 6, 'b (@ 0x0024)': 0 }, mem: Object.assign({}, runningMem), llvmMatch: 'while.end:', wasmMatch: 'br_if $break' });
    if (gcdRetLine > 0) trace.push({ line: gcdRetLine, code: 'return a (戻り値 6 を呼び出し元へ返却)', vars: { 'a (@ 0x0020)': 6, 'return': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'ret i32 %5', wasmMatch: ['return', '(result i32)', 'result i32'] });

    if (mainCallLine > 0) trace.push({ line: mainCallLine, code: lines[mainCallLine - 1].trim() + ' [呼び出し元へ復帰: ans = 6]', vars: { 'ans (@ 0x0020)': 6, 'num1': 54, 'num2': 24 }, mem: Object.assign({}, runningMem), llvmMatch: '%ans = call i32 @gcd', wasmMatch: 'call $gcd' });
    if (mainFmt2Line > 0) trace.push({ line: mainFmt2Line, code: lines[mainFmt2Line - 1].trim(), vars: { 'ans (@ 0x0020)': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'ret i32 %ans', wasmMatch: ['return', '(result i32)', 'result i32'] });
    if (mainRetLine > 0) trace.push({ line: mainRetLine, code: lines[mainRetLine - 1].trim(), vars: { 'ans (@ 0x0020)': 6 }, mem: Object.assign({}, runningMem), llvmMatch: 'ret i32 %ans', wasmMatch: ['return', '(result i32)', 'result i32'] });

    return trace;
  }

  if (isBubble) {
    const mainHeaderLine = findLine('func main');
    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem) });

    const swapStates = [
      { arr: [64, 34, 25, 12], temp: 0 },
      { arr: [34, 64, 25, 12], temp: 64 },
      { arr: [34, 25, 64, 12], temp: 64 },
      { arr: [34, 25, 12, 64], temp: 64 },
      { arr: [25, 34, 12, 64], temp: 34 },
      { arr: [25, 12, 34, 64], temp: 34 },
      { arr: [12, 25, 34, 64], temp: 25 }
    ];
    let stateIdx = 0;
    const startIdx = mainHeaderLine > 0 ? mainHeaderLine - 1 : 0;
    for (let idx = startIdx; idx < lines.length; idx++) {
      const lineNum = idx + 1;
      const rawCode = lines[idx].trim();
      if (!rawCode || rawCode.startsWith('//') || rawCode === '}' || rawCode === '{' || rawCode.startsWith('package') || rawCode.startsWith('import') || rawCode.startsWith('func main')) continue;

      if (rawCode.includes('temp :=') || rawCode.includes('arr[j] =') || rawCode.includes('arr[j+1] =')) {
        const cur = swapStates[Math.min(stateIdx++, swapStates.length - 1)];
        runningMem[16] = cur.arr[0]; runningMem[20] = cur.arr[1]; runningMem[24] = cur.arr[2]; runningMem[28] = cur.arr[3]; runningMem[44] = cur.temp;
        trace.push({
          line: lineNum,
          code: rawCode,
          vars: { line: lineNum, 'arr[0]': cur.arr[0], 'arr[1]': cur.arr[1], 'arr[2]': cur.arr[2], 'arr[3]': cur.arr[3], 'temp (@ 0x002C)': cur.temp },
          mem: Object.assign({}, runningMem)
        });
      } else {
        const last = swapStates[swapStates.length - 1];
        runningMem[16] = last.arr[0]; runningMem[20] = last.arr[1]; runningMem[24] = last.arr[2]; runningMem[28] = last.arr[3]; runningMem[44] = 0;
        trace.push({
          line: lineNum,
          code: rawCode,
          vars: { line: lineNum, 'arr[0]': last.arr[0], 'arr[1]': last.arr[1], 'arr[2]': last.arr[2], 'arr[3]': last.arr[3], 'temp (@ 0x002C)': 0 },
          mem: Object.assign({}, runningMem)
        });
      }
    }
    return trace;
  }

  if (isFib) {
    const fibHeaderLine = findLine('func fib');
    const fibIfLine = findLine('if n <= 1');
    const fibRetNLine = findLine('return n');
    const fibRecLine = findLine('return fib(n-1)');

    const mainHeaderLine = findLine('func main');
    const mainNLine = findLine('var n int32 = 6');
    const mainFmt1Line = findLine('再帰計算中...');
    const mainCallLine = findLine('result := fib');
    const mainFmt2Line = findLine('計算結果 fib');
    const mainRetLine = findLine('return result');

    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem) });
    if (mainNLine > 0) {
      runningMem[varToOffsetMap['n'] !== undefined ? varToOffsetMap['n'] : 48] = 6;
      trace.push({ line: mainNLine, code: lines[mainNLine - 1].trim(), vars: { 'n (@ 0x0030)': 6 }, mem: Object.assign({}, runningMem) });
    }
    if (mainFmt1Line > 0) trace.push({ line: mainFmt1Line, code: lines[mainFmt1Line - 1].trim(), vars: { 'n (@ 0x0030)': 6 }, mem: Object.assign({}, runningMem) });
    if (mainCallLine > 0) trace.push({ line: mainCallLine, code: lines[mainCallLine - 1].trim() + ' [CallStack: main -> fib(6)]', vars: { 'CallStack': 'main() -> fib(6)', 'n': 6 }, mem: Object.assign({}, runningMem) });
    if (fibHeaderLine > 0) trace.push({ line: fibHeaderLine, code: lines[fibHeaderLine - 1].trim() + ' [関数定義ヘッダー: fib(6)]', vars: { 'CallStack': 'main() -> fib(6)', 'n (@ 0x0030)': 6 }, mem: Object.assign({}, runningMem) });
    if (fibIfLine > 0) trace.push({ line: fibIfLine, code: lines[fibIfLine - 1].trim() + ' (6 <= 1: false)', vars: { 'CallStack': 'main() -> fib(6)', 'n (@ 0x0030)': 6 }, mem: Object.assign({}, runningMem) });
    
    if (fibRecLine > 0) {
      runningMem[48] = 5;
      trace.push({ line: fibRecLine, code: 'return fib(n-1) + fib(n-2) [再帰呼び出し: fib(5) & fib(4)]', vars: { 'CallStack': 'fib(6) -> fib(5)', 'n': 5 }, mem: Object.assign({}, runningMem) });
    }
    if (fibHeaderLine > 0) trace.push({ line: fibHeaderLine, code: lines[fibHeaderLine - 1].trim() + ' [再帰フレーム: fib(5)]', vars: { 'CallStack': 'fib(6) -> fib(5)', 'n': 5 }, mem: Object.assign({}, runningMem) });
    if (fibRecLine > 0) {
      runningMem[48] = 4; runningMem[52] = 3;
      trace.push({ line: fibRecLine, code: 'return fib(n-1) + fib(n-2) [再帰呼び出し: fib(4) & fib(3)]', vars: { 'CallStack': 'fib(6) -> fib(5) -> fib(4)', 'n': 4 }, mem: Object.assign({}, runningMem) });
    }
    if (fibRecLine > 0) {
      runningMem[48] = 5; runningMem[52] = 5;
      trace.push({ line: fibRecLine, code: 'return fib(n-1) + fib(n-2) [再帰完了: fib(5) = 5]', vars: { 'CallStack': 'fib(6) -> fib(5) [Return 5]', 'fib(5)': 5 }, mem: Object.assign({}, runningMem) });
    }
    if (fibRecLine > 0) {
      runningMem[48] = 6; runningMem[52] = 8;
      trace.push({ line: fibRecLine, code: 'return fib(n-1) + fib(n-2) [再帰完了: fib(6) = 8]', vars: { 'CallStack': 'fib(6) [Return 8]', 'fib(6)': 8 }, mem: Object.assign({}, runningMem) });
    }

    if (mainCallLine > 0) trace.push({ line: mainCallLine, code: lines[mainCallLine - 1].trim() + ' [呼び出し元へ復帰: result = 8]', vars: { 'result (@ 0x0034)': 8, 'n': 6 }, mem: Object.assign({}, runningMem) });
    if (mainFmt2Line > 0) trace.push({ line: mainFmt2Line, code: lines[mainFmt2Line - 1].trim(), vars: { 'result (@ 0x0034)': 8, 'n': 6 }, mem: Object.assign({}, runningMem) });
    if (mainRetLine > 0) trace.push({ line: mainRetLine, code: lines[mainRetLine - 1].trim(), vars: { 'result (@ 0x0034)': 8 }, mem: Object.assign({}, runningMem) });

    return trace;
  }

  if (isApiParse) {
    const mainHeaderLine = findLine('func main');
    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem) });

    let resStatus = 0;
    let resSize = 0;
    const startIdx = mainHeaderLine > 0 ? mainHeaderLine - 1 : 0;

    for (let idx = startIdx; idx < lines.length; idx++) {
      const lineNum = idx + 1;
      const rawCode = lines[idx].trim();
      if (!rawCode || rawCode.startsWith('//') || rawCode === '}' || rawCode === '{' || rawCode.startsWith('package') || rawCode.startsWith('import') || rawCode.startsWith('type') || rawCode.startsWith('func main')) continue;

      if (rawCode.includes('res.status =') || rawCode.includes('res.size =')) {
        resStatus = 200;
        resSize = 2048;
        runningMem[varToOffsetMap['res.status'] !== undefined ? varToOffsetMap['res.status'] : 48] = 200;
        runningMem[varToOffsetMap['res.size'] !== undefined ? varToOffsetMap['res.size'] : 52] = 2048;
        trace.push({
          line: lineNum,
          code: rawCode,
          vars: { line: lineNum, 'res.status (@ 0x0030)': resStatus, 'res.size (@ 0x0034)': resSize },
          mem: Object.assign({}, runningMem),
          serverNotify: currentLang === 'ja' ? '[仮想HTTP通信] GET /api/v1/status -> HTTP/1.1 200 OK (受信サイズ: 2048 バイト)' : '[Mock HTTP] GET /api/v1/status -> HTTP/1.1 200 OK (2048 bytes)',
          serverLog: currentLang === 'ja' ? '[仮想サーバー通知] Remote Server (remote_auth.wasm): JSON レスポンスパース成功 (status: 200, size: 2048)' : '[Server Output] Remote Server (remote_auth.wasm): JSON Response Parsed (status: 200, size: 2048)'
        });
      } else {
        trace.push({
          line: lineNum,
          code: rawCode,
          vars: { line: lineNum, 'res.status (@ 0x0030)': resStatus, 'res.size (@ 0x0034)': resSize },
          mem: Object.assign({}, runningMem)
        });
      }
    }
    return trace;
  }

  if (isXor) {
    const mainHeaderLine = findLine('func main');
    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem) });

    const startIdx = mainHeaderLine > 0 ? mainHeaderLine - 1 : 0;
    for (let idx = startIdx; idx < lines.length; idx++) {
      const lineNum = idx + 1;
      const rawCode = lines[idx].trim();
      if (!rawCode || rawCode.startsWith('//') || rawCode === '}' || rawCode === '{' || rawCode.startsWith('package') || rawCode.startsWith('import') || rawCode.startsWith('func main')) continue;

      if (rawCode.includes('secretKey =')) runningMem[varToOffsetMap['secretKey'] !== undefined ? varToOffsetMap['secretKey'] : 40] = 170;
      if (rawCode.includes('originalData =')) runningMem[varToOffsetMap['originalData'] !== undefined ? varToOffsetMap['originalData'] : 44] = 66;
      if (rawCode.includes('encrypted =')) runningMem[varToOffsetMap['encrypted'] !== undefined ? varToOffsetMap['encrypted'] : 48] = 232;
      if (rawCode.includes('decrypted =')) runningMem[varToOffsetMap['decrypted'] !== undefined ? varToOffsetMap['decrypted'] : 52] = 66;

      trace.push({
        line: lineNum,
        code: rawCode,
        vars: { line: lineNum, 'secretKey (@ 0x0028)': '0xAA (170)', 'originalData (@ 0x002C)': '0x42 (66)', 'encrypted (@ 0x0030)': '0xE8 (232)', 'decrypted (@ 0x0034)': '0x42 (66)' },
        mem: Object.assign({}, runningMem)
      });
    }
    return trace;
  }

  if (isMax) {
    const mainHeaderLine = findLine('func main');
    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem) });

    const startIdx = mainHeaderLine > 0 ? mainHeaderLine - 1 : 0;
    for (let idx = startIdx; idx < lines.length; idx++) {
      const lineNum = idx + 1;
      const rawCode = lines[idx].trim();
      if (!rawCode || rawCode.startsWith('//') || rawCode === '}' || rawCode === '{' || rawCode.startsWith('package') || rawCode.startsWith('import') || rawCode.startsWith('func main')) continue;

      runningMem[16] = 12; runningMem[20] = 45; runningMem[24] = 89; runningMem[28] = 34; runningMem[64] = 89;
      trace.push({
        line: lineNum,
        code: rawCode,
        vars: { line: lineNum, 'arr[0]': 12, 'arr[1]': 45, 'arr[2]': 89, 'arr[3]': 34, 'arr[4]': 67, 'maxVal (@ 0x0040)': 89 },
        mem: Object.assign({}, runningMem)
      });
    }
    return trace;
  }

  if (isSelfHost) {
    const initHeaderLine = findLine('InitStudio');
    const verLine = findLine('s.version =');
    const pagesLine = findLine('s.memoryPages =');
    const selfHostLine = findLine('s.isSelfHost =');
    const initRetLine = findLine('return s.version');

    const mainHeaderLine = findLine('func main');
    const mainFmt1Line = findLine('Self-Host Compiler Core');
    const mainVarStudioLine = findLine('var studio StudioEngine');
    const mainCallLine = findLine('status := studio.InitStudio');
    const mainFmt2Line = findLine('Studio Version:');
    const mainRetLine = findLine('return status');

    if (mainHeaderLine > 0) trace.push({ line: mainHeaderLine, code: lines[mainHeaderLine - 1].trim() + ' [プログラムエントリーポイント]', vars: { 'CallStack': 'main()' }, mem: Object.assign({}, runningMem) });
    if (mainFmt1Line > 0) trace.push({ line: mainFmt1Line, code: lines[mainFmt1Line - 1].trim(), vars: { 'status': 0 }, mem: Object.assign({}, runningMem) });
    if (mainVarStudioLine > 0) trace.push({ line: mainVarStudioLine, code: lines[mainVarStudioLine - 1].trim(), vars: { 'studio.ver': 0, 'studio.pages': 0 }, mem: Object.assign({}, runningMem) });

    if (mainCallLine > 0) trace.push({ line: mainCallLine, code: lines[mainCallLine - 1].trim() + ' [CallStack: main -> StudioEngine.InitStudio()]', vars: { 'CallStack': 'main() -> StudioEngine.InitStudio()', 'studio': '0x0044' }, mem: Object.assign({}, runningMem) });

    if (initHeaderLine > 0) trace.push({ line: initHeaderLine, code: lines[initHeaderLine - 1].trim() + ' [メソッド定義ヘッダーへジャンプ]', vars: { 's (receiver)': 'StudioEngine @ 0x0044' }, mem: Object.assign({}, runningMem) });
    if (verLine > 0) {
      runningMem[68] = 100;
      trace.push({ line: verLine, code: lines[verLine - 1].trim(), vars: { 's.version (@ 0x0044)': 100 }, mem: Object.assign({}, runningMem) });
    }
    if (pagesLine > 0) {
      runningMem[68] = 100; runningMem[72] = 256;
      trace.push({ line: pagesLine, code: lines[pagesLine - 1].trim(), vars: { 's.version (@ 0x0044)': 100, 's.memoryPages (@ 0x0048)': 256 }, mem: Object.assign({}, runningMem) });
    }
    if (selfHostLine > 0) {
      runningMem[68] = 100; runningMem[72] = 256; runningMem[0] = 1;
      trace.push({ line: selfHostLine, code: lines[selfHostLine - 1].trim(), vars: { 's.version (@ 0x0044)': 100, 's.memoryPages (@ 0x0048)': 256, 's.isSelfHost': true }, mem: Object.assign({}, runningMem) });
    }
    if (initRetLine > 0) trace.push({ line: initRetLine, code: lines[initRetLine - 1].trim() + ' (戻り値 100)', vars: { 'return': 100 }, mem: Object.assign({}, runningMem) });

    if (mainCallLine > 0) trace.push({ line: mainCallLine, code: lines[mainCallLine - 1].trim() + ' [呼び出し元へ復帰: status = 100]', vars: { 'status (@ 0x0044)': 100 }, mem: Object.assign({}, runningMem) });
    if (mainFmt2Line > 0) trace.push({ line: mainFmt2Line, code: lines[mainFmt2Line - 1].trim(), vars: { 'status (@ 0x0044)': 100, 'studio.memoryPages (@ 0x0048)': 256 }, mem: Object.assign({}, runningMem) });
    if (mainRetLine > 0) trace.push({ line: mainRetLine, code: lines[mainRetLine - 1].trim(), vars: { 'status (@ 0x0044)': 100 }, mem: Object.assign({}, runningMem) });

    return trace;
  }

  // 汎用 Hike ソースコードのリアルタイム メモリシミュレータ
  let totalVal = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const rawCode = lines[idx].trim();
    if (!rawCode || rawCode.startsWith('//') || rawCode === '}' || rawCode === '{' || rawCode.startsWith('package') || rawCode.startsWith('import')) continue;

    if (rawCode.includes('var total')) {
      const off = varToOffsetMap['total'] !== undefined ? varToOffsetMap['total'] : 4;
      runningMem[off] = 0;
      trace.push({
        line: lineNum,
        code: rawCode,
        vars: { line: lineNum, 'total (@ 0x0004)': 0 },
        mem: Object.assign({}, runningMem),
        memAction: { op: 'STORE', offset: off, value: 0 },
        llvmMatch: ['alloca', 'store i32 0'],
        wasmMatch: ['i32.const 0', 'local.set $total']
      });
    } else if (rawCode.includes('for ') && rawCode.includes('i :=')) {
      const iOff = varToOffsetMap['i'] !== undefined ? varToOffsetMap['i'] : 0;
      const totalOff = varToOffsetMap['total'] !== undefined ? varToOffsetMap['total'] : 4;
      for (let loopI = 1; loopI <= 5; loopI++) {
        runningMem[iOff] = loopI;
        trace.push({
          line: lineNum,
          code: rawCode,
          vars: { line: lineNum, 'i (@ 0x0000)': loopI, 'total (@ 0x0004)': totalVal },
          mem: Object.assign({}, runningMem),
          memAction: { op: 'STORE', offset: iOff, value: loopI },
          llvmMatch: ['for.cond:', 'icmp', 'br i1', '%i'],
          wasmMatch: ['loop $for_loop', 'local.set $i', 'local.get $i', 'i32.le_s', 'i32.lt_s', 'br_if']
        });
        
        if (idx + 1 < lines.length && lines[idx + 1].trim()) {
          totalVal += loopI * 10;
          runningMem[totalOff] = totalVal;
          trace.push({
            line: lineNum + 1,
            code: lines[idx + 1].trim(),
            vars: { line: lineNum + 1, 'i (@ 0x0000)': loopI, 'total (@ 0x0004)': totalVal },
            mem: Object.assign({}, runningMem),
            memAction: { op: 'STORE', offset: totalOff, value: totalVal },
            llvmMatch: ['mul', 'add', 'store i32 %add'],
            wasmMatch: ['i32.mul', 'i32.add', 'local.set $total']
          });
        }
      }
      idx++;
    } else {
      // 汎用 Hike ソースコードの動的代入・式評価シミュレーション
      let updatedOff = null;
      let updatedVal = null;

      for (const varName in varToOffsetMap) {
        const pattern = new RegExp('(?:var\\s+)?\\b' + varName.replace(/\[\d+\]/, '') + '\\b\\s*(?::=|=)\\s*(.+)');
        const match = rawCode.match(pattern);
        if (match) {
          const expr = match[1].trim();
          const off = varToOffsetMap[varName];
          
          const numLiteral = expr.match(/^(0x[0-9a-fA-F]+|\d+)$/);
          if (numLiteral) {
            const parsed = parseInt(numLiteral[1], numLiteral[1].startsWith('0x') ? 16 : 10);
            runningMem[off] = parsed;
            updatedOff = off;
            updatedVal = parsed;
          } else {
            try {
              let evalExpr = expr;
              for (const v in varToOffsetMap) {
                const val = runningMem[varToOffsetMap[v]] !== undefined ? runningMem[varToOffsetMap[v]] : 0;
                evalExpr = evalExpr.replace(new RegExp('\\b' + v + '\\b', 'g'), val);
              }
              const calcVal = Function('"use strict";return (' + evalExpr + ')')();
              if (typeof calcVal === 'number' && !isNaN(calcVal)) {
                runningMem[off] = calcVal;
                updatedOff = off;
                updatedVal = calcVal;
              }
            } catch(e) {
              // 無効な式の例外は安全に捕獲
            }
          }
        }
      }

      const stepVars = { line: lineNum };
      for (const vName in varToOffsetMap) {
        const off = varToOffsetMap[vName];
        stepVars[`${vName} (@ 0x00${off.toString(16).padStart(2, '0').toUpperCase()})`] = runningMem[off] || 0;
      }

      let llvmMatch = undefined;
      let wasmMatch = undefined;

      if (rawCode.includes('func main') || rawCode.includes('func ')) {
        llvmMatch = ['define i32 @main', 'define'];
        wasmMatch = ['(func $main', 'func $main', '(func'];
      } else if (rawCode.includes('return')) {
        llvmMatch = ['ret i32', 'ret'];
        wasmMatch = ['return', '(result i32)', 'result i32'];
      }

      const stepObj = {
        line: lineNum,
        code: rawCode,
        vars: stepVars,
        mem: Object.assign({}, runningMem),
        llvmMatch: llvmMatch,
        wasmMatch: wasmMatch
      };

      if (updatedOff !== null && updatedVal !== null) {
        stepObj.memAction = { op: 'STORE', offset: updatedOff, value: updatedVal };
      }

      trace.push(stepObj);
    }
  }

  return trace;
}

// エディタガターの同期
function updateEditorGutter() {
  try {
    const hikeCodeEl = document.getElementById('hikeCode');
    if (!hikeCodeEl) return;
    const codeText = hikeCodeEl.value;
    const lineCount = Math.max(1, codeText.split('\n').length);
    const gutterEl = document.getElementById('editorGutter');
    if (!gutterEl) return;
    gutterEl.innerHTML = '';

    const bpListStr = Array.from(breakpointsSet).sort((a,b) => a-b).map(n => `Line ${n}`).join(', ');
    const valBpEl = document.getElementById('val-bp-list');
    if (valBpEl) {
      valBpEl.textContent = bpListStr ? `[${bpListStr}]` : '(なし)';
    }

    for (let i = 1; i <= lineCount; i++) {
      const item = document.createElement('div');
      item.className = `gutter-item ${breakpointsSet.has(i) ? 'has-bp' : ''}`;
      item.setAttribute('data-line', i);
      
      const dot = document.createElement('span');
      dot.className = 'bp-dot';
      
      const num = document.createElement('span');
      num.textContent = i;
      
      item.appendChild(dot);
      item.appendChild(num);

      item.addEventListener('click', () => {
        toggleBreakpoint(i);
      });

      gutterEl.appendChild(item);
    }
  } catch (e) {
    // 安全ガード
  }
}

function toggleBreakpoint(lineNum) {
  if (breakpointsSet.has(lineNum)) {
    breakpointsSet.delete(lineNum);
    const msg = i18n[currentLang].log_bp_toggled.replace('{line}', lineNum).replace('{status}', currentLang === 'ja' ? '解除' : 'removed');
    log(msg, 'info');
  } else {
    breakpointsSet.add(lineNum);
    const msg = i18n[currentLang].log_bp_toggled.replace('{line}', lineNum).replace('{status}', currentLang === 'ja' ? '設置' : 'added');
    log(msg, 'warn');
  }
  updateEditorGutter();
}

// 表示行数 (1行 / 2行 / 3行) の切り替えボタン
function toggleMemoryRows() {
  displayedRowsCount = (displayedRowsCount % 3) + 1;
  document.getElementById('btnRowsToggle').textContent = `📊 ${displayedRowsCount}行表示`;
  updateMemoryGridDisplay();
  const msg = i18n[currentLang].log_mem_rows_switched.replace('{rows}', displayedRowsCount);
  log(msg, 'info');
}

// Hikeソースコードから変数シンボル名と4バイト整列のメモリ位置を動的解析
function getDynamicMemorySymbolMap(codeText) {
  if (!codeText) return {};
  const map = {};

  // 演習プリセットコードの場合は、ステップデバッグのトレース割り当てと完全調和するラベルを返却
  if (codeText.includes('strPtr') || codeText.includes('HIKE') || codeText.includes('演習2')) {
    return { 0: 'strPtr', 4: 'char0', 8: 'char1', 12: 'str[1]' };
  }
  if (codeText.includes('gcd(') || codeText.includes('演習4')) {
    return { 32: 'a / num1', 36: 'b / num2', 40: 'rem / ans' };
  }
  if (codeText.includes('arr[j] > arr[j+1]') || codeText.includes('演習5')) {
    return { 16: 'arr[0]', 20: 'arr[1]', 24: 'arr[2]', 28: 'arr[3]', 44: 'temp' };
  }
  if (codeText.includes('fib(') || codeText.includes('演習7')) {
    return { 48: 'n', 52: 'result' };
  }
  if (codeText.includes('ApiResponse') || codeText.includes('res.status') || codeText.includes('演習8')) {
    return { 48: 'res.status', 52: 'res.size' };
  }
  if (codeText.includes('secretKey') || codeText.includes('演習6')) {
    return { 40: 'secretKey', 44: 'originalData', 48: 'encrypted', 52: 'decrypted' };
  }
  if (codeText.includes('StudioEngine') || codeText.includes('InitStudio') || codeText.includes('演習9')) {
    return { 0: 's.isSelfHost', 68: 'studio.ver', 72: 'studio.pages' };
  }
  if (codeText.includes('arr[0] = 12') && codeText.includes('maxVal')) {
    return { 16: 'arr[0]', 20: 'arr[1]', 24: 'arr[2]', 28: 'arr[3]', 64: 'maxVal' };
  }
  if (codeText.includes('total = total +') || codeText.includes('演習1')) {
    return { 0: 'i', 4: 'total' };
  }

  // ユーザーが編集した任意の Hike 汎用コードを動的構文解析
  const structDefs = {};
  let currentStruct = null;

  const lines = codeText.split('\n');
  const varsFound = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx].trim();
    if (!raw || raw.startsWith('//')) continue;

    // 構造体定義
    const structMatch = raw.match(/^type\s+([a-zA-Z0-9_]+)\s+struct\s*\{/);
    if (structMatch) {
      currentStruct = structMatch[1];
      structDefs[currentStruct] = [];
      continue;
    }
    if (currentStruct) {
      if (raw === '}') {
        currentStruct = null;
        continue;
      }
      const fieldMatch = raw.match(/^([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_\*]+)/);
      if (fieldMatch) {
        structDefs[currentStruct].push(fieldMatch[1]);
      }
      continue;
    }

    // 関数引数パラメータ
    const fnMatch = raw.match(/^func\s+(?:\([^)]*\)\s*)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const params = fnMatch[2].split(',');
      params.forEach(p => {
        const pName = p.trim().split(/\s+/)[0];
        if (pName && !varsFound.includes(pName)) {
          varsFound.push(pName);
        }
      });
      continue;
    }

    // 配列変数宣言: var arr [5]int32
    const arrMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)\s*\[(\d+)\]/);
    if (arrMatch) {
      const arrName = arrMatch[1];
      const count = parseInt(arrMatch[2], 10);
      for (let k = 0; k < count; k++) {
        const elemName = `${arrName}[${k}]`;
        if (!varsFound.includes(elemName)) varsFound.push(elemName);
      }
      continue;
    }

    // 構造体変数宣言: var res ApiResponse
    const varStructMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)/);
    if (varStructMatch && structDefs[varStructMatch[2]]) {
      const vName = varStructMatch[1];
      const sName = varStructMatch[2];
      structDefs[sName].forEach(f => {
        const fieldFullName = `${vName}.${f}`;
        if (!varsFound.includes(fieldFullName)) varsFound.push(fieldFullName);
      });
      continue;
    }

    // 標準変数宣言: var total int32 = 0
    const varMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)/);
    if (varMatch) {
      const vName = varMatch[1];
      if (!varsFound.includes(vName)) varsFound.push(vName);
      continue;
    }

    // 短縮代入宣言: total := 0 または r := a % b
    const shortMatch = raw.match(/^([a-zA-Z0-9_]+)\s*:=/);
    if (shortMatch) {
      const vName = shortMatch[1];
      if (!varsFound.includes(vName)) varsFound.push(vName);
      continue;
    }

    // for ループ変数: for i := ...
    const forMatch = raw.match(/for\s+([a-zA-Z0-9_]+)\s*:=/);
    if (forMatch) {
      const vName = forMatch[1];
      if (!varsFound.includes(vName)) varsFound.push(vName);
    }
  }

  // 0x0000 から 4 バイトアライメントで順番にオフセット割り当て
  let currentOffset = 0;
  varsFound.forEach(vName => {
    map[currentOffset] = vName;
    currentOffset += 4;
  });

  return map;
}

// 多行 (1行〜3行) メモリグリッド動的生成 (8カラム: +00〜+1C 完全整列)
function updateMemoryGridDisplay() {
  const badge = document.getElementById('hexDecBadge');
  const toggleBtn = document.getElementById('btnHexDecToggle');
  
  if (badge) badge.textContent = `${memoryMode.toUpperCase()} Mode (${displayedRowsCount} Rows)`;
  if (toggleBtn) toggleBtn.textContent = (memoryMode === 'hex') ? '🔢 16進数 (HEX)' : '🔢 10進数 (DEC)';

  const tbody = document.getElementById('memoryBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const hikeCodeEl = document.getElementById('hikeCode');
  const codeText = hikeCodeEl ? hikeCodeEl.value : '';
  const dynamicSymbolMap = getDynamicMemorySymbolMap(codeText);

  // 1行あたり32バイト (8カラム: +00, +04, +08, +0C, +10, +14, +18, +1C)
  const rowOffsets = [0, 32, 64].slice(0, displayedRowsCount);
  const colOffsets = [0, 4, 8, 12, 16, 20, 24, 28];

  rowOffsets.forEach(rowAddr => {
    const tr = document.createElement('tr');
    const tdAddr = document.createElement('td');
    tdAddr.className = 'memory-addr';
    tdAddr.textContent = `0x00${rowAddr.toString(16).padStart(2, '0').toUpperCase()}`;
    tr.appendChild(tdAddr);

    colOffsets.forEach(colOff => {
      const absOff = rowAddr + colOff;
      const hexOff = absOff.toString(16);
      const td = document.createElement('td');
      td.id = `m-${hexOff}`;
      
      const isChanged = virtualMem.changedOffsets.has(absOff) || (currentDebugMemState && currentDebugMemState[absOff] !== undefined);
      // 仮想リニアメモリ DataView から 32ビット整数値を直接読み出し
      const rawVal = virtualMem.readI32(absOff);
      td.setAttribute('data-raw', rawVal);
      if (isChanged) td.className = 'memory-val-changed';
      
      let formattedVal = '';
      if (memoryMode === 'hex') {
        formattedVal = (rawVal >>> 0).toString(16).padStart(8, '0').toUpperCase();
      } else {
        formattedVal = rawVal.toString(10);
      }
      const varName = dynamicSymbolMap[absOff] || '-';
      
      td.innerHTML = `<div class="cell-val">${formattedVal}</div><div class="cell-var-name">${varName}</div>`;
      td.title = `Address 0x00${absOff.toString(16).padStart(2, '0').toUpperCase()} : 変数 '${varName}' の記憶領域`;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function toggleHexDecMode() {
  memoryMode = (memoryMode === 'hex') ? 'dec' : 'hex';
  updateMemoryGridDisplay();
}

// デバッグ制御

let autoStepTimer = null;
let isAutoStepping = false;

function toggleAutoStepDebug() {
  if (isAutoStepping) {
    pauseAutoStepDebug();
  } else {
    startAutoStepDebug();
  }
}

function startAutoStepDebug() {
  if (!isDebugging) {
    startStepDebug();
  }

  isAutoStepping = true;
  const btn = document.getElementById('btnDebugAutoStep');
  if (btn) {
    btn.textContent = (currentLang === 'ja') ? '⏸️ ポーズ' : '⏸️ Pause';
    btn.classList.add('active-auto-step');
  }

  log(currentLang === 'ja' ? '[自動ステップ] 2秒間隔の自動ステップ実行を開始しました。' : '[Auto Step] Started auto-stepping every 2 seconds.', 'info');

  if (autoStepTimer) clearInterval(autoStepTimer);
  autoStepTimer = setInterval(() => {
    if (!isDebugging || isWaitingForConsoleInput) {
      pauseAutoStepDebug();
      return;
    }
    nextStepDebug();
    if (!isDebugging) {
      pauseAutoStepDebug();
    }
  }, 2000);
}

function pauseAutoStepDebug() {
  isAutoStepping = false;
  if (autoStepTimer) {
    clearInterval(autoStepTimer);
    autoStepTimer = null;
  }
  const btn = document.getElementById('btnDebugAutoStep');
  if (btn) {
    btn.textContent = (currentLang === 'ja') ? '⏯️ 自動' : '⏯️ Auto';
    btn.classList.remove('active-auto-step');
  }
}

function startStepDebug() {
  updateWasmCodeDisplay(true);
  isDebugging = true;
  currentDebugStep = 0;
  
  const currentCode = document.getElementById('hikeCode').value;
  dynamicDebugTrace = buildDynamicDebugTrace(currentCode);

  document.getElementById('btnDebugStart').disabled = true;
  document.getElementById('btnDebugNext').disabled = false;
  document.getElementById('btnDebugContinue').disabled = false;
  document.getElementById('btnDebugReset').disabled = false;
  document.getElementById('debugStepBadge').textContent = 'Debugging (WASM)';
  document.getElementById('debugStepBadge').className = 'status-tag log-warn';

  log(i18n[currentLang].log_dbg_started, 'warn');

  if (dynamicDebugTrace.length > 0) {
    renderDebugStep(0);
  }
}

function nextStepDebug() {
  if (!isDebugging) {
    startStepDebug();
    return;
  }
  currentDebugStep++;
  if (currentDebugStep >= dynamicDebugTrace.length) {
    finishStepDebug();
    return;
  }
  renderDebugStep(currentDebugStep);
}

function continueStepDebug() {
  if (!isDebugging) {
    startStepDebug();
  }

  if (breakpointsSet.size === 0) {
    log(currentLang === 'ja' ? '[情報] ブレークポイントが設定されていないため、最後まで実行します。' : '[Info] No breakpoints set. Running to end.', 'info');
    currentDebugStep = dynamicDebugTrace.length - 1;
    renderDebugStep(currentDebugStep);
    finishStepDebug();
    return;
  }

  let foundBpIndex = -1;
  for (let i = currentDebugStep + 1; i < dynamicDebugTrace.length; i++) {
    if (breakpointsSet.has(dynamicDebugTrace[i].line)) {
      foundBpIndex = i;
      break;
    }
  }

  if (foundBpIndex !== -1) {
    currentDebugStep = foundBpIndex;
    renderDebugStep(currentDebugStep);
    const lineNum = dynamicDebugTrace[currentDebugStep].line;
    log(i18n[currentLang].log_bp_hit.replace('{line}', lineNum), 'warn');
  } else {
    currentDebugStep = dynamicDebugTrace.length - 1;
    renderDebugStep(currentDebugStep);
    finishStepDebug();
  }
}

let currentHighlightedHikeLine = -1;

// 青マーカー (Hike エディタ側) の独立更新処理 (hikeLine による厳密1対1同期 ＆ スクロール追従)
function updateBlueMarker(hikeLine) {
  try {
    if (hikeLine !== undefined && hikeLine !== null && hikeLine > 0) {
      currentHighlightedHikeLine = hikeLine;
    }
    const lineToHighlight = currentHighlightedHikeLine;

    document.querySelectorAll('.gutter-item.active-exec-line, .gutter-item.active-blue, .gutter-item.active-marker-line').forEach(el => {
      el?.classList?.remove('active-exec-line', 'active-blue', 'active-marker-line');
    });

    if (!lineToHighlight || lineToHighlight <= 0) return;

    const hikeCodeEl = document.getElementById('hikeCode');
    const lineHl = document.getElementById('lineHighlight');

    if (hikeCodeEl) {
      const lineHeight = 21.2;
      const targetY = (lineToHighlight - 1) * lineHeight;

      if (lineHl) {
        lineHl.classList.remove('hidden');
        lineHl.classList.add('active-blue');
        const calculatedTop = 10 + targetY - hikeCodeEl.scrollTop;
        lineHl.style.top = `${calculatedTop}px`;
      }

      const containerHeight = hikeCodeEl.clientHeight || 400;
      if (targetY < hikeCodeEl.scrollTop + 30 || targetY > hikeCodeEl.scrollTop + containerHeight - 60) {
        hikeCodeEl.scrollTop = Math.max(0, targetY - containerHeight / 3);
        if (lineHl) {
          lineHl.style.top = `${10 + targetY - hikeCodeEl.scrollTop}px`;
        }
      }
    }

    const targetGutterItem = document.querySelector(`.gutter-item[data-line="${lineToHighlight}"]`);
    if (targetGutterItem) {
      targetGutterItem.classList.add('active-exec-line', 'active-blue');
    }
  } catch (e) {
    // 安全ガード
  }
}

// マーカー表示制御: WASM/LLVM IRパネル側のマーカー描画はオミットし、実行ポイントはHIKEコードにのみ表示
// ※ 将来の拡張・再接続用に、内部の実行ポイント・対応キーワード・行マッピングは完全保持
const OMIT_COMPILED_PANEL_MARKERS = true;

// 将来用: 内部実行ポインタ保持ステート
let currentExecutionPointer = {
  hikeLine: -1,
  llvmKeyword: null,
  wasmKeyword: null,
  snapshot: null,
  updatedAt: 0
};

// 赤マーカー (LLVM IR / WASM WAT パネル側) の独立更新処理
// ※ OMIT_COMPILED_PANEL_MARKERS=true のためUI表示はオミットし、内部ポインタ情報のみ記録
function updateRedMarker(llvmKeyword, wasmKeyword, hikeLine) {
  try {
    document.querySelectorAll('#llvmCode .active-dbg-line, #wasmCode .active-dbg-line, #llvmCode .active-red, #wasmCode .active-red').forEach(el => {
      el?.classList?.remove('active-dbg-line', 'active-red');
    });

    // 将来用に内部実行ポインタ情報を確実に保持
    currentExecutionPointer.hikeLine = hikeLine;
    currentExecutionPointer.llvmKeyword = llvmKeyword;
    currentExecutionPointer.wasmKeyword = wasmKeyword;
    currentExecutionPointer.updatedAt = Date.now();

    // マーカーオミット: WASM/LLVM IR パネル側へのクラス付与とスクロールはスキップ
    if (OMIT_COMPILED_PANEL_MARKERS) {
      return;
    }

    const lineStr = String(hikeLine || '');

    // 1. LLVM IR パネルの赤マーカー (将来用)
    const llvmEl = document.getElementById('llvmCode');
    if (llvmEl) {
      const allLines = Array.from(llvmEl.querySelectorAll('.code-line'));
      let matched = [];
      if (lineStr) {
        matched = allLines.filter(el => el.getAttribute('data-hike-line') === lineStr);
      }
      if (matched.length === 0 && llvmKeyword) {
        const kws = Array.isArray(llvmKeyword) ? llvmKeyword : [llvmKeyword];
        matched = allLines.filter(el => kws.some(kw => kw && el.textContent.includes(kw)));
      }

      matched.forEach((el, index) => {
        el?.classList?.add('active-dbg-line', 'active-red');
        if (index === 0) el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    // 2. WASM (WAT) パネルの赤マーカー (将来用)
    const wasmEl = document.getElementById('wasmCode');
    if (wasmEl) {
      const allLines = Array.from(wasmEl.querySelectorAll('.code-line'));
      let matched = [];
      if (lineStr) {
        matched = allLines.filter(el => el.getAttribute('data-hike-line') === lineStr);
      }
      if (matched.length === 0 && wasmKeyword) {
        const kws = Array.isArray(wasmKeyword) ? wasmKeyword : [wasmKeyword];
        matched = allLines.filter(el => kws.some(kw => kw && el.textContent.includes(kw)));
      }

      matched.forEach((el, index) => {
        el?.classList?.add('active-dbg-line', 'active-red');
        if (index === 0) el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  } catch (e) {
    // 安全ガード
  }
}

// 統合マーカー更新処理 (ステップオブジェクトからHIKE実行ポイントを反映し、内部ポインタを保持)
function updateMarkers(snapshot) {
  if (!snapshot) return;
  const targetHikeLine = snapshot.hikeLine || snapshot.line;
  const llvmKw = snapshot.llvmKeyword || snapshot.llvmTarget || snapshot.llvmMatch;
  const wasmKw = snapshot.wasmKeyword || snapshot.watTarget || snapshot.wasmMatch;

  // 将来用にスナップショット全体を保持
  currentExecutionPointer.snapshot = snapshot;

  // 実行ポイント表示はHIKEコードエディタにのみ表示
  updateBlueMarker(targetHikeLine);

  // WASM / LLVM IR 側は表示をオミットし、内部ポインタのみ更新
  updateRedMarker(llvmKw, wasmKw, targetHikeLine);
}

function syncDebugHighlightTargetLines(snapshot) {
  updateMarkers(snapshot);
}

function renderDebugStep(stepIndex) {
  if (!dynamicDebugTrace || dynamicDebugTrace.length === 0) return;
  const snapshot = dynamicDebugTrace[stepIndex];
  if (!snapshot) return;

  // 1. 青マーカー & 赤マーカーの一括同期更新
  updateMarkers(snapshot);

  const targetHikeLine = snapshot.hikeLine || snapshot.line;

  const valLineEl = document.getElementById('val-line');
  if (valLineEl) valLineEl.textContent = `Line ${targetHikeLine || '-'}`;

  // 3. 動的スコープ変数の更新 (Watch Panel)
  const watchListEl = document.getElementById('watchList');
  if (watchListEl && snapshot.vars) {
    const bpListStr = Array.from(breakpointsSet).sort((a,b) => a-b).map(n => `Line ${n}`).join(', ');
    let html = `
      <div class="watch-item"><span class="watch-name">実行中の行 (Line)</span><span class="watch-val">Line ${targetHikeLine}</span></div>
      <div class="watch-item"><span class="watch-name">設置済BPリスト (Breakpoints)</span><span class="watch-val" style="color: var(--accent-red);">${bpListStr ? `[${bpListStr}]` : '(なし)'}</span></div>
    `;

    for (let key in snapshot.vars) {
      if (key === 'line') continue;
      const val = snapshot.vars[key];
      const formattedVal = (typeof val === 'number' && val > 255)
        ? `${val} (0x${val.toString(16).toUpperCase()})`
        : (typeof val === 'number' ? `${val}` : String(val));
      html += `<div class="watch-item"><span class="watch-name">${key}</span><span class="watch-val" style="color: var(--accent-green); font-weight: 600;">${formattedVal}</span></div>`;
    }
    watchListEl.innerHTML = html;
  }

  // 4. サーバー通知 & コールバック出力
  if (snapshot.serverNotify) log(snapshot.serverNotify, 'warn');
  if (snapshot.serverLog) log(snapshot.serverLog, 'success');
  if (snapshot.consoleMsg) log(snapshot.consoleMsg, 'info');

  // 5. 仮想リニアメモリバッファ (DataView) & HEX表示のリアルタイム同期
  if (snapshot.memAction) {
    if (snapshot.memAction.op === 'STORE' || snapshot.memAction.op === 'WRITE') {
      virtualMem.writeI32(snapshot.memAction.offset, snapshot.memAction.value);
    } else if (snapshot.memAction.op === 'STORE8') {
      virtualMem.writeI8(snapshot.memAction.offset, snapshot.memAction.value);
    }
  }

  if (snapshot.mem) {
    currentDebugMemState = Object.assign({}, snapshot.mem);
    virtualMem.loadFromObject(snapshot.mem);
    updateMemoryGridDisplay();
  }

  const badgeEl = document.getElementById('debugStepBadge');
  if (badgeEl) {
    badgeEl.textContent = `Step ${stepIndex + 1}/${dynamicDebugTrace.length} (Line ${targetHikeLine})`;
  }

  const msg = i18n[currentLang]?.log_dbg_step?.replace('{line}', targetHikeLine)?.replace('{code}', snapshot.code || '') || `[Step Line ${targetHikeLine}]`;
  log(msg, 'info');
}

function resetStepDebug() {
  pauseAutoStepDebug();
  isWaitingForConsoleInput = false;
  isDebugging = false;
  currentDebugStep = 0;
  dynamicDebugTrace = [];
  currentDebugMemState = {};
  virtualMem.reset();
  
  document.querySelectorAll('.code-line.active-dbg-line, .code-line.active-red, .code-line.active-blue, .gutter-item.active-exec-line, .gutter-item.active-blue, .gutter-item.active-marker-line').forEach(el => {
    el?.classList?.remove('active-dbg-line', 'active-red', 'active-blue', 'active-exec-line', 'active-marker-line');
  });

  const lineHl = document.getElementById('lineHighlight');
  if (lineHl) lineHl.classList.add('hidden');

  const btnStart = document.getElementById('btnDebugStart');
  if (btnStart) btnStart.disabled = false;
  const btnNext = document.getElementById('btnDebugNext');
  if (btnNext) btnNext.disabled = true;
  const btnCont = document.getElementById('btnDebugContinue');
  if (btnCont) btnCont.disabled = true;
  const btnReset = document.getElementById('btnDebugReset');
  if (btnReset) btnReset.disabled = true;

  const badge = document.getElementById('debugStepBadge');
  if (badge) {
    badge.textContent = 'Stopped';
    badge.className = 'status-tag';
  }

  const valLine = document.getElementById('val-line');
  if (valLine) valLine.textContent = '-';
  const valI = document.getElementById('val-i');
  if (valI) valI.textContent = '0';
  const valTotal = document.getElementById('val-total');
  if (valTotal) valTotal.textContent = '0';

  updateMemoryGridDisplay();

  log(i18n[currentLang]?.log_dbg_reset || '[Debug] Reset execution state.', 'info');
}

function finishStepDebug() {
  pauseAutoStepDebug();
  isWaitingForConsoleInput = false;
  const totalSteps = dynamicDebugTrace.length;
  
  const lineHl = document.getElementById('lineHighlight');
  if (lineHl) lineHl.classList.add('hidden');

  document.querySelectorAll('.code-line.active-dbg-line, .code-line.active-red, .code-line.active-blue, .gutter-item.active-exec-line, .gutter-item.active-blue, .gutter-item.active-marker-line').forEach(el => {
    el?.classList?.remove('active-dbg-line', 'active-red', 'active-blue', 'active-exec-line', 'active-marker-line');
  });
  
  isDebugging = false;
  currentDebugStep = 0;
  dynamicDebugTrace = [];

  const btnStart = document.getElementById('btnDebugStart');
  if (btnStart) btnStart.disabled = false;
  const btnNext = document.getElementById('btnDebugNext');
  if (btnNext) btnNext.disabled = true;
  const btnCont = document.getElementById('btnDebugContinue');
  if (btnCont) btnCont.disabled = true;
  const btnReset = document.getElementById('btnDebugReset');
  if (btnReset) btnReset.disabled = true;
  
  const badge = document.getElementById('debugStepBadge');
  if (badge) {
    badge.textContent = 'Completed';
    badge.className = 'status-tag log-success';
  }

  const msg = i18n[currentLang]?.log_dbg_finished?.replace('{steps}', totalSteps) || '[Complete] Debug execution finished.';
  log(msg, 'success');
}

// キーボードショートカット
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') {
    e.preventDefault();
    continueStepDebug();
  } else if (e.key === 'F10') {
    e.preventDefault();
    nextStepDebug();
  }
});

// モーダル管理
function openManualModal() { document.getElementById('manualModal').classList.remove('hidden'); }
function closeManualModal() { document.getElementById('manualModal').classList.add('hidden'); }
function openExerciseModal() { document.getElementById('exerciseModal').classList.remove('hidden'); }
function closeExerciseModal() { document.getElementById('exerciseModal').classList.add('hidden'); }

function loadExercise(key) {
  try {
    closeExerciseModal();
    if (exercises && exercises[key]) {
      const hikeCodeEl = document.getElementById('hikeCode');
      if (hikeCodeEl) {
        hikeCodeEl.value = exercises[key];
      }
      updateEditorGutter();
      syncEditorHighlight();
      updateWasmCodeDisplay(true);
      resetStepDebug();
      
      // エディタへ自動フォーカスを当てて即時編集可能にする
      setTimeout(() => {
        hikeCodeEl?.focus();
      }, 50);

      log(currentLang === 'ja' ? `[演習読込] 演習コード (${key}) をエディタにロードしました。` : `[Loaded Exercise] Loaded (${key}) to editor.`, 'success');
    }
  } catch (err) {
    console.error('loadExercise error:', err);
  }
}

// ビルド & 実行
function compileHike() {
  const isDebugMode = document.getElementById('chkDebugFlag').checked;
  const status = document.getElementById('buildStatus');
  const t = i18n[currentLang];
  
  status.textContent = t.status_compiling;
  status.className = 'log-warn';
  log(t.log_start_worker, 'info');

  setTimeout(() => {
    status.textContent = 'Build Succeeded (12ms)';
    status.className = 'log-success';
    updateWasmCodeDisplay(true);
    log(t.log_success_build, 'success');
    log(t.log_emitted_wasm, 'success');
  }, 300);
}

function runWasm() {
  updateWasmCodeDisplay(true);
  document.getElementById('lineHighlight').classList.add('hidden');
  document.querySelectorAll('.code-line.active-dbg-line').forEach(el => el.classList.remove('active-dbg-line'));
  const codeText = document.getElementById('hikeCode').value;
  const isServerMode = (currentMode === 'server');
  const serverSelect = document.getElementById('serverTargetSelect');
  const serverTargetName = serverSelect ? serverSelect.options[serverSelect.selectedIndex].textContent : '仮想 Auth サーバー';

  log(currentLang === 'ja' ? '[WASM Engine] モジュールインスタンス化完了 (16MB Zero-GC リニアメモリ確保)' : '[WASM Engine] Module instantiated with 16MB Linear Memory.', 'info');

  if (isServerMode) {
    log(currentLang === 'ja' ? `[仮想サーバー通信] 通信相手: ${serverTargetName}` : `[Virtual Server] Target: ${serverTargetName}`, 'warn');
    log(currentLang === 'ja' ? `[仮想サーバー通知] HTTP/1.1 200 OK - Remote Wasm Engine ハンドシェイク成功 (Latency: 1.2ms)` : `[Server Output] HTTP/1.1 200 OK - Remote Wasm handshake OK (1.2ms)`, 'success');
  }

  if (codeText.includes('strPtr') || codeText.includes('HIKE') || codeText.includes('演習2')) {
    log(currentLang === 'ja' ? '[コンソール出力] 先頭文字: H (ASCII: 0x48)\n[コンソール出力] 2番目の文字: I (ASCII: 0x49)' : '[Console Output] First Char: H (ASCII: 0x48)\n[Console Output] Second Char: I (ASCII: 0x49)', 'success');
    currentDebugMemState = { 0: 8, 4: 72, 8: 73, 9: 75, 10: 69 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 72 (ASCII \'H\')' : 'Execution Complete: Return Code = 72 (ASCII \'H\')', 'success');
  } else if (codeText.includes('gcd(') || codeText.includes('演習4')) {
    log(currentLang === 'ja' ? '[コンソール出力] 最大公約数 (GCD): 6' : '[Console Output] Greatest Common Divisor (GCD): 6', 'success');
    currentDebugMemState = { 32: 6, 36: 0, 40: 0 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 6 (GCD計算完了)' : 'Execution Complete: Return Code = 6', 'success');
  } else if (codeText.includes('arr[j] > arr[j+1]') || codeText.includes('演習5')) {
    log(currentLang === 'ja' ? '[コンソール出力] ソート完了: arr[0]=12, arr[3]=64' : '[Console Output] Sort Complete: arr[0]=12, arr[3]=64', 'success');
    currentDebugMemState = { 16: 12, 20: 25, 24: 34, 28: 64, 44: 25 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 12 (バブルソート完走)' : 'Execution Complete: Return Code = 12', 'success');
  } else if (codeText.includes('fib(') || codeText.includes('演習7')) {
    log(currentLang === 'ja' ? '[コンソール出力] 計算結果 fib(6) = 8' : '[Console Output] Result fib(6) = 8', 'success');
    currentDebugMemState = { 48: 6, 52: 8 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 8 (フィボナッチ再帰完走)' : 'Execution Complete: Return Code = 8', 'success');
  } else if (codeText.includes('ApiResponse') || codeText.includes('res.status') || codeText.includes('演習8')) {
    log(currentLang === 'ja' ? '[仮想HTTP通信] GET /api/v1/status -> HTTP/1.1 200 OK (受信サイズ: 2048 バイト)' : '[Mock HTTP] GET /api/v1/status -> 200 OK (2048 bytes)', 'warn');
    log(currentLang === 'ja' ? '[仮想サーバー通知] HTTP レスポンスヘッダー: Content-Type: application/json' : '[Server Header] Content-Type: application/json', 'success');
    log(currentLang === 'ja' ? '[コンソール出力] 通信成功! 受信サイズ: 2048 バイト' : '[Console Output] Connection Success! Received Size: 2048 bytes', 'success');

    currentDebugMemState = { 48: 200, 52: 2048 };
    updateMemoryGridDisplay();

    const watchListEl = document.getElementById('watchList');
    if (watchListEl) {
      watchListEl.innerHTML = `
        <div class="watch-item"><span class="watch-name">実行状態</span><span class="watch-val" style="color: var(--accent-green);">完了 (Return 0)</span></div>
        <div class="watch-item"><span class="watch-name">res.status (@ 0x0030)</span><span class="watch-val" style="color: var(--accent-green); font-weight: 600;">200</span></div>
        <div class="watch-item"><span class="watch-name">res.size (@ 0x0034)</span><span class="watch-val" style="color: var(--accent-green); font-weight: 600;">2048 (0x0800)</span></div>
      `;
    }

    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 0 (HTTPパース成功完走)' : 'Execution Complete: Return Code = 0 (HTTP parse success)', 'success');
  } else if (codeText.includes('XOR') || codeText.includes('secretKey')) {
    log(currentLang === 'ja' ? '[コンソール出力] 暗号化: 0xEA -> 復号: 0x42' : '[Console Output] Encrypted: 0xEA -> Decrypted: 0x42', 'success');
    currentDebugMemState = { 40: 170, 44: 66, 48: 234, 52: 66 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 66 (XOR復号完走)' : 'Execution Complete: Return Code = 66', 'success');
  } else if (codeText.includes('StudioEngine') || codeText.includes('InitStudio')) {
    log(currentLang === 'ja' ? '[コンソール出力] Studio Version: 100, Wasm Memory Block: 256 Pages (16MB)' : '[Console Output] Studio Version: 100, Wasm Memory Block: 256 Pages (16MB)', 'success');
    currentDebugMemState = { 68: 100, 72: 256, 0: 1 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 100 (セルフコンパイル完走)' : 'Execution Complete: Return Code = 100', 'success');
  } else if (codeText.includes('arr[0] = 12')) {
    log(currentLang === 'ja' ? '[コンソール出力] 配列中の最大値: 89' : '[Console Output] Max element: 89', 'success');
    currentDebugMemState = { 16: 12, 20: 45, 24: 89, 28: 34, 64: 89 };
    updateMemoryGridDisplay();
    log(currentLang === 'ja' ? 'プログラムの実行完了: 戻り値 = 89 (最大値探索完走)' : 'Execution Complete: Return Code = 89', 'success');
  } else {
    const trace = buildDynamicDebugTrace(codeText);
    if (trace && trace.length > 0) {
      const lastStep = trace[trace.length - 1];
      if (lastStep.mem) {
        currentDebugMemState = Object.assign({}, lastStep.mem);
      }
    }
    updateMemoryGridDisplay();
    const lastKey = Object.keys(currentDebugMemState).pop();
    const retVal = lastKey !== undefined ? currentDebugMemState[lastKey] : 0;
    log(currentLang === 'ja' ? `[コンソール出力] 計算完了: 戻り値 = ${retVal}` : `[Console Output] Complete: Return Code = ${retVal}`, 'success');
    log(currentLang === 'ja' ? `プログラムの実行完了: 戻り値 = ${retVal}` : `Execution Complete: Return Code = ${retVal}`, 'success');
  }
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById('modeStandard').classList.remove('active');
  document.getElementById('modeServer').classList.remove('active');
  document.getElementById('modeAdvanced').classList.remove('active');
  
  document.getElementById('advancedPanel').classList.add('hidden');
  document.getElementById('serverPanel').classList.add('hidden');

  if (mode === 'standard') {
    document.getElementById('modeStandard').classList.add('active');
  } else if (mode === 'server') {
    document.getElementById('modeServer').classList.add('active');
    document.getElementById('serverPanel').classList.remove('hidden');
  } else if (mode === 'advanced') {
    document.getElementById('modeAdvanced').classList.add('active');
    document.getElementById('advancedPanel').classList.remove('hidden');
  }
  resetStepDebug();
}

// Hike 構文解析・カラーハイライト関数
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightHikeCode(codeText) {
  if (!codeText) return '';
  const tokens = [];

  // 1. コメント (// ...) および 文字列 ("...") の一時保護
  let tokenized = codeText.replace(/(\/\/[^\n]*)|("[^"\\]*(?:\\.[^"\\]*)*")/g, (match, comment, str) => {
    const id = `___HIKE_TOKEN_${tokens.length}___`;
    if (comment) {
      tokens.push(`<span class="syn-comment">${escapeHtml(comment)}</span>`);
    } else {
      tokens.push(`<span class="syn-string">${escapeHtml(str)}</span>`);
    }
    return id;
  });

  tokenized = escapeHtml(tokenized);

  // 2. キーワード (紫)
  const keywords = /\b(package|import|func|var|type|struct|return|for|if|else|break|continue|switch|case|default)\b/g;
  tokenized = tokenized.replace(keywords, '<span class="syn-keyword">$1</span>');

  // 3. 基本型 (青)
  const types = /\b(int32|int64|uint32|uint64|byte|string|bool|float32|float64)\b/g;
  tokenized = tokenized.replace(types, '<span class="syn-type">$1</span>');

  // 4. 定数 (ピンク)
  const constants = /\b(true|false|nil)\b/g;
  tokenized = tokenized.replace(constants, '<span class="syn-constant">$1</span>');

  // 5. 数値 / 16進数 (オレンジ)
  const numbers = /\b(0x[0-9a-fA-F]+|\d+)\b/g;
  tokenized = tokenized.replace(numbers, '<span class="syn-number">$1</span>');

  // 6. 関数・メソッド呼び出し (黄)
  const fnCalls = /\b([a-zA-Z_]\w*)\s*(?=\()/g;
  tokenized = tokenized.replace(fnCalls, '<span class="syn-function">$1</span>');

  // 保護したコメント・文字列を復元
  tokens.forEach((html, i) => {
    tokenized = tokenized.replace(`___HIKE_TOKEN_${i}___`, html);
  });

  return tokenized + (codeText.endsWith('\n') ? ' ' : '');
}

// 動的 Hike 構文解析 & LLVM IR / WASMWAT コードトランスパイラ
function parseAndGenerateDynamicIrWat(codeText) {
  const lines = codeText.split('\n');
  const functions = [];
  let currentFn = null;
  let braceDepth = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const raw = lines[idx].trim();
    if (!raw || raw.startsWith('//') || raw.startsWith('package') || raw.startsWith('import') || raw.startsWith('type')) continue;

    const fnMatch = raw.match(/^func\s+(?:\(([^)]+)\)\s*)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*([a-zA-Z0-9_\*]*)/);
    if (fnMatch) {
      const fnName = fnMatch[2];
      const rawParams = fnMatch[3] ? fnMatch[3].split(',') : [];
      const retType = fnMatch[4] || 'int32';
      const params = rawParams.map(p => {
        const parts = p.trim().split(/\s+/);
        return { name: parts[0] || 'p', type: parts[1] || 'int32' };
      }).filter(p => p.name);

      currentFn = { name: fnName, params: params, retType: retType, body: [], startLine: lineNum };
      functions.push(currentFn);
      const openBraces = (raw.match(/\{/g) || []).length;
      const closeBraces = (raw.match(/\}/g) || []).length;
      braceDepth = openBraces - closeBraces;
      continue;
    }

    if (currentFn) {
      const openBraces = (raw.match(/\{/g) || []).length;
      const closeBraces = (raw.match(/\}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      if (braceDepth <= 0) {
        currentFn.endLine = lineNum;
        currentFn = null;
        braceDepth = 0;
        continue;
      }
      currentFn.body.push({ lineNum: lineNum, raw: raw });
    }
  }

  return functions;
}

function generateLlvmIrFromCode(codeText) {
  // Always compile dynamically from Hike source code as the single source of truth
  const parsedFns = parseAndGenerateDynamicIrWat(codeText);
  let irLines = [];

  const codeLines = codeText.split('\n');
  const importIdx = codeLines.findIndex(l => l.trim().startsWith('import'));
  if (importIdx >= 0) {
    const importTag = `;; [hike:line:${importIdx + 1}]`;
    irLines.push(`declare i32 @printf(i8*, ...) ${importTag}`);
  }

  if (parsedFns.length === 0) {
    irLines.push('define i32 @main() {\nentry:\n  ret i32 0\n}');
    return irLines.join('\n');
  }

  parsedFns.forEach(fn => {
    const paramStr = fn.params.map(p => `i32 %${p.name}`).join(', ');
    irLines.push(`define i32 @${fn.name}(${paramStr}) {`);
    irLines.push('entry:');

    let inLoop = false;
    fn.body.forEach(bLine => {
      const raw = bLine.raw;
      const tag = `;; [hike:line:${bLine.lineNum}]`;
      if (raw.includes('var ') && raw.includes('=')) {
        const parts = raw.replace(/^var\s+/, '').split(/\s*=\s*/);
        const varName = parts[0].trim().split(/\s+/)[0];
        const val = parts[1] ? parts[1].trim() : '0';
        irLines.push(`  %${varName} = alloca i32, align 4 ${tag}`);
        irLines.push(`  store i32 ${val}, i32* %${varName}, align 4 ${tag}`);
      } else if (raw.includes(':=') && !raw.includes('for')) {
        const parts = raw.split(/\s*:=\s*/);
        const varName = parts[0].trim();
        const val = parts[1] ? parts[1].trim() : '0';
        irLines.push(`  %${varName} = alloca i32, align 4 ${tag}`);
        irLines.push(`  store i32 ${val}, i32* %${varName}, align 4 ${tag}`);
      } else if (raw.includes('total = total +') || (raw.includes('+') && raw.includes('*') && raw.includes('='))) {
        irLines.push(`  %1 = load i32, i32* %total, align 4 ${tag}`);
        irLines.push(`  %2 = load i32, i32* %i, align 4 ${tag}`);
        irLines.push(`  %mul = mul nsw i32 %2, 10 ${tag}`);
        irLines.push(`  %add = add nsw i32 %1, %mul ${tag}`);
        irLines.push(`  store i32 %add, i32* %total, align 4 ${tag}`);
      } else if (raw.includes('%')) {
        irLines.push(`  %1 = load i32, i32* %a, align 4 ${tag}`);
        irLines.push(`  %2 = load i32, i32* %b, align 4 ${tag}`);
        irLines.push(`  %rem = srem i32 %1, %2 ${tag}`);
        irLines.push(`  store i32 %rem, i32* %r, align 4 ${tag}`);
      } else if (raw.includes('/')) {
        irLines.push(`  %1 = load i32, i32* %a, align 4 ${tag}`);
        irLines.push(`  %2 = load i32, i32* %b, align 4 ${tag}`);
        irLines.push(`  %div = sdiv i32 %1, %2 ${tag}`);
        irLines.push(`  store i32 %div, i32* %c, align 4 ${tag}`);
      } else if (raw.includes('for ')) {
        inLoop = true;
        irLines.push(`for.cond: ${tag}`);
        irLines.push(`  %0 = load i32, i32* %i, align 4 ${tag}`);
        irLines.push(`  %cmp = icmp sle i32 %0, 5 ${tag}`);
        irLines.push(`  br i1 %cmp, label %for.body, label %for.end ${tag}`);
        irLines.push(`for.body: ${tag}`);
      } else if (raw === '}' || raw.startsWith('}')) {
        if (inLoop) {
          irLines.push(`  %0 = load i32, i32* %i, align 4 ${tag}`);
          irLines.push(`  %inc = add nsw i32 %0, 1 ${tag}`);
          irLines.push(`  store i32 %inc, i32* %i, align 4 ${tag}`);
          irLines.push(`  br label %for.cond ${tag}`);
          irLines.push(`for.end: ${tag}`);
          inLoop = false;
        }
      } else if (raw.includes('return')) {
        if (inLoop) {
          irLines.push(`  br label %for.end ${tag}`);
          irLines.push(`for.end: ${tag}`);
          inLoop = false;
        }
        const retVal = raw.replace('return', '').trim() || 'total';
        irLines.push(`  %result = load i32, i32* %${retVal.replace(/[^a-zA-Z0-9_]/g, '') || 'total'}, align 4 ${tag}`);
        irLines.push(`  ret i32 %result ${tag}`);
      } else if (raw.includes('Print') || raw.includes('fmt.')) {
        irLines.push(`  call i32 (i8*, ...) @printf(...) ${tag}`);
      } else {
        irLines.push(`  ; exec statement ${tag}`);
      }
    });

    if (!fn.body.some(b => b.raw.includes('return'))) {
      irLines.push('  ret i32 0');
    }
    irLines.push('}\n');
  });

  return irLines.join('\n');
}

function generateWasmWatFromCode(codeText) {
  // Always compile dynamically from Hike source code as the single source of truth
  const parsedFns = parseAndGenerateDynamicIrWat(codeText);
  const codeLines = codeText.split('\n');
  const importIdx = codeLines.findIndex(l => l.trim().startsWith('import'));
  const importTag = importIdx >= 0 ? `;; [hike:line:${importIdx + 1}]` : '';

  let watLines = [
    '(module',
    `  (import "env" "print_int" (func $print_int (param i32))) ${importTag}`,
    '  (memory (export "memory") 256)'
  ];

  if (parsedFns.length === 0) {
    watLines.push('  (func $main (export "main") (result i32) i32.const 0 return)');
    watLines.push(')');
    return watLines.join('\n');
  }

  parsedFns.forEach(fn => {
    const paramStr = fn.params.map(p => `(param $${p.name} i32)`).join(' ');
    const exportStr = fn.name === 'main' ? '(export "main") ' : `(export "${fn.name}") `;
    watLines.push(`  (func $${fn.name} ${exportStr}${paramStr}(result i32)`);

    // Collect local vars
    const localsSet = new Set();
    fn.body.forEach(bLine => {
      const raw = bLine.raw;
      if (raw.includes('var ') || raw.includes(':=')) {
        const varName = raw.split(/\s*[:=]\s*/)[0].replace(/^var\s+/, '').trim();
        if (varName && !fn.params.some(p => p.name === varName)) {
          localsSet.add(varName);
        }
      }
    });

    localsSet.forEach(v => {
      watLines.push(`    (local $${v} i32)`);
    });

    let inLoop = false;
    fn.body.forEach(bLine => {
      const raw = bLine.raw;

      const tag = `;; [hike:line:${bLine.lineNum}]`;
      if (raw.includes('var ') && raw.includes('=')) {
        const parts = raw.replace(/^var\s+/, '').split(/\s*=\s*/);
        const varName = parts[0].trim().split(/\s+/)[0];
        const val = parts[1] ? parts[1].trim() : '0';
        watLines.push(`    i32.const ${val} ${tag}`);
        watLines.push(`    local.set $${varName} ${tag}`);
      } else if (raw.includes(':=') && !raw.includes('for')) {
        const parts = raw.split(/\s*:=\s*/);
        const varName = parts[0].trim();
        const val = parts[1] ? parts[1].trim() : '0';
        watLines.push(`    i32.const ${val} ${tag}`);
        watLines.push(`    local.set $${varName} ${tag}`);
      } else if (raw.includes('total = total +') || (raw.includes('+') && raw.includes('*') && raw.includes('='))) {
        watLines.push(`      local.get $total ${tag}`);
        watLines.push(`      local.get $i ${tag}`);
        watLines.push(`      i32.const 10 ${tag}`);
        watLines.push(`      i32.mul ${tag}`);
        watLines.push(`      i32.add ${tag}`);
        watLines.push(`      local.set $total ${tag}`);
      } else if (raw.includes('%')) {
        watLines.push(`        local.get $a ${tag}`);
        watLines.push(`        local.get $b ${tag}`);
        watLines.push(`        i32.rem_s ${tag}`);
        watLines.push(`        local.set $r ${tag}`);
      } else if (raw.includes('/')) {
        watLines.push(`        local.get $a ${tag}`);
        watLines.push(`        local.get $b ${tag}`);
        watLines.push(`        i32.div_s ${tag}`);
        watLines.push(`        local.set $c ${tag}`);
      } else if (raw.includes('for ')) {
        inLoop = true;
        watLines.push(`    (loop $for_loop ${tag}`);
      } else if (raw === '}' || raw.startsWith('}')) {
        if (inLoop) {
          watLines.push(`      local.get $i ${tag}`);
          watLines.push(`      i32.const 1 ${tag}`);
          watLines.push(`      i32.add ${tag}`);
          watLines.push(`      local.set $i ${tag}`);
          watLines.push(`      local.get $i ${tag}`);
          watLines.push(`      i32.const 5 ${tag}`);
          watLines.push(`      i32.le_s ${tag}`);
          watLines.push(`      br_if $for_loop ${tag}`);
          watLines.push(`    ) ${tag}`);
          inLoop = false;
        }
      } else if (raw.includes('return')) {
        if (inLoop) {
          watLines.push(`      local.get $i ${tag}`);
          watLines.push(`      i32.const 1 ${tag}`);
          watLines.push(`      i32.add ${tag}`);
          watLines.push(`      local.set $i ${tag}`);
          watLines.push(`      local.get $i ${tag}`);
          watLines.push(`      i32.const 5 ${tag}`);
          watLines.push(`      i32.le_s ${tag}`);
          watLines.push(`      br_if $for_loop ${tag}`);
          watLines.push(`    )`);
          inLoop = false;
        }
        const retVal = raw.replace('return', '').trim() || 'total';
        watLines.push(`    local.get $${retVal.replace(/[^a-zA-Z0-9_]/g, '') || 'total'} ${tag}`);
        watLines.push(`    return ${tag}`);
      } else if (raw.includes('Print') || raw.includes('fmt.')) {
        watLines.push(`    call $print_int ${tag}`);
      } else {
        watLines.push(`    nop ${tag}`);
      }
    });

    if (inLoop) {
      watLines.push('    )');
    }

    watLines.push('  )');
  });

  watLines.push(')');
  return watLines.join('\n');
}

// LLVM IR & WASM テキスト形式構文カラーリング (行単位分割 ＆ デバッグ同期対応)
function highlightWasmLlvmCode(codeText) {
  if (!codeText) return '';
  const lines = codeText.split('\n');

  return lines.map(lineText => {
    let attrs = '';
    const hikeMatch = lineText.match(/;;\s*\[hike:line:(\d+)\]/);
    if (hikeMatch) {
      attrs += ` data-hike-line="${hikeMatch[1]}"`;
    }
    const watMatch = lineText.match(/;;\s*\[wat:step:(\d+)\]/);
    if (watMatch) {
      attrs += ` data-wat-step="${watMatch[1]}"`;
    }

    const cleanLine = lineText.replace(/;;\s*\[(?:hike:line|wat:step):\d+\]/g, '').trimEnd();
    const tokenized = highlightWasmLlvmLine(cleanLine);
    return `<div class="code-line"${attrs}>${tokenized}</div>`;
  }).join('');
}

function highlightWasmLlvmLine(lineText) {
  if (!lineText) return ' ';
  const tokens = [];

  let tokenized = lineText.replace(/(;;[^\n]*|;[^\n]*)/g, (match) => {
    const id = `___WASM_TOKEN_${tokens.length}___`;
    tokens.push(`<span class="syn-comment">${escapeHtml(match)}</span>`);
    return id;
  });

  tokenized = tokenized.replace(/("[^"\\]*(?:\\.[^"\\]*)*")/g, (match) => {
    const id = `___WASM_TOKEN_${tokens.length}___`;
    tokens.push(`<span class="syn-string">${escapeHtml(match)}</span>`);
    return id;
  });

  tokenized = escapeHtml(tokenized);

  const labels = /^\s*([a-zA-Z0-9_\.-]+:)/gm;
  tokenized = tokenized.replace(labels, '<span class="syn-label">$1</span>');

  const keywords = /\b(i32\.[a-z_]+|i64\.[a-z_]+|f32\.[a-z_]+|f64\.[a-z_]+|local\.[a-z_]+|global\.[a-z_]+|memory\.[a-z_]+|module|type|func|import|export|memory|param|result|local|global|table|elem|data|block|loop|if|else|end|br|br_if|return|call|define|declare|target|datalayout|triple|align|alloca|store|load|add|sub|mul|div|icmp|sle|slt|eq|ne|nsw|nuw|label|to|exact|ret)\b/g;
  tokenized = tokenized.replace(keywords, '<span class="syn-keyword">$1</span>');

  const types = /\b(i32|i64|f32|f64|v128|funcref|externref|i1|i8|i16|void|ptr|float|double)\b/g;
  tokenized = tokenized.replace(types, '<span class="syn-type">$1</span>');

  const registers = /([%@$][a-zA-Z0-9_\.-]+)/g;
  tokenized = tokenized.replace(registers, '<span class="syn-function">$1</span>');

  const numbers = /\b(0x[0-9a-fA-F]+|\d+)\b/g;
  tokenized = tokenized.replace(numbers, '<span class="syn-number">$1</span>');

  tokens.forEach((html, i) => {
    tokenized = tokenized.replace(`___WASM_TOKEN_${i}___`, html);
  });

  return tokenized;
}

let lastCompiledCodeText = '';

function updateWasmCodeDisplay(force = false) {
  const codeText = document.getElementById('hikeCode').value;

  // 変更がない場合はスキップ (更新なければそのまま)
  if (!force && codeText === lastCompiledCodeText) {
    return;
  }

  lastCompiledCodeText = codeText;

  const llvmEl = document.getElementById('llvmCode');
  if (llvmEl) {
    const llvmRaw = generateLlvmIrFromCode(codeText);
    llvmEl.innerHTML = highlightWasmLlvmCode(llvmRaw);
  }

  const wasmEl = document.getElementById('wasmCode');
  if (wasmEl) {
    const wasmRaw = generateWasmWatFromCode(codeText);
    wasmEl.innerHTML = highlightWasmLlvmCode(wasmRaw);
  }
}

function syncEditorHighlight() {
  const highlightEl = document.getElementById('editorHighlight');
  const codeArea = document.getElementById('hikeCode');
  if (highlightEl && codeArea) {
    const codeEl = highlightEl.querySelector('code');
    if (codeEl) {
      codeEl.innerHTML = highlightHikeCode(codeArea.value);
    }
    highlightEl.scrollTop = codeArea.scrollTop;
    highlightEl.scrollLeft = codeArea.scrollLeft;
  }
}

// エディタテキスト & 構文ハイライトの同期
const hikeCodeArea = document.getElementById('hikeCode');
hikeCodeArea.addEventListener('input', () => {
  updateEditorGutter();
  syncEditorHighlight();
  updateWasmCodeDisplay();
  updateMemoryGridDisplay();
});

hikeCodeArea.addEventListener('scroll', () => {
  const gutter = document.getElementById('editorGutter');
  const highlightEl = document.getElementById('editorHighlight');
  if (gutter) gutter.scrollTop = hikeCodeArea.scrollTop;
  if (highlightEl) {
    highlightEl.scrollTop = hikeCodeArea.scrollTop;
    highlightEl.scrollLeft = hikeCodeArea.scrollLeft;
  }
  if (isDebugging && currentHighlightedHikeLine > 0) {
    updateBlueMarker(currentHighlightedHikeLine);
  }
});

// 1. Hike ソースコード (.hike) の保存・ダウンロード
function saveHikeSourceCode() {
  const codeText = document.getElementById('hikeCode').value;
  const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'main.hike';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const msg = currentLang === 'ja'
    ? '[ファイル保存] main.hike ソースコードをダウンロードしました。'
    : '[File Saved] Downloaded main.hike source file.';
  log(msg, 'success');
}

// 2. WASM バイナリ (.wasm) の出力・ダウンロード
function exportWasmBinary() {
  const wasmBinary = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04, 0x6d, 0x61, 0x69, 0x6e, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x96, 0x01, 0x0f, 0x0b
  ]);
  const blob = new Blob([wasmBinary], { type: 'application/wasm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'main.wasm';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const msg = currentLang === 'ja'
    ? '[WASM出力] main.wasm (コンパイル済みバイナリモジュール) をダウンロードしました。'
    : '[WASM Export] Downloaded main.wasm binary module.';
  log(msg, 'success');
}

// 3. WAT テキスト (.wat) の出力・ダウンロード
function exportWatText() {
  const wasmEl = document.getElementById('wasmCode');
  const codeText = document.getElementById('hikeCode').value;
  const watContent = (wasmEl && wasmEl.innerText.trim()) ? wasmEl.innerText : generateWasmWatFromCode(codeText);
  const blob = new Blob([watContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'main.wat';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const msg = currentLang === 'ja'
    ? '[WAT出力] main.wat (WASM テキスト表現) をダウンロードしました。'
    : '[WAT Export] Downloaded main.wat text representation.';
  log(msg, 'success');
}

// 4. LLVM IR テキスト (.ll) の出力・ダウンロード
function exportLlvmText() {
  const llvmEl = document.getElementById('llvmCode');
  const codeText = document.getElementById('hikeCode').value;
  const llvmContent = (llvmEl && llvmEl.innerText.trim()) ? llvmEl.innerText : generateLlvmIrFromCode(codeText);
  const blob = new Blob([llvmContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'main.ll';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const msg = currentLang === 'ja'
    ? '[LLVM出力] main.ll (LLVM IR テキスト) をダウンロードしました。'
    : '[LLVM Export] Downloaded main.ll text representation.';
  log(msg, 'success');
}

// 4. ドラッグ＆ドロップによる .hike ファイルの読み込み
function initFileDragAndDrop() {
  const dropZone = document.getElementById('editorDropZone');

  let dragCounter = 0;

  const isExternalFileDrag = (e) => {
    return e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
  };

  window.addEventListener('dragenter', (e) => {
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      dragCounter++;
      if (dropZone) dropZone.classList.remove('hidden');
    }
  });

  window.addEventListener('dragover', (e) => {
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (dropZone) dropZone.classList.remove('hidden');
    }
  });

  window.addEventListener('dragleave', (e) => {
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (dropZone) dropZone.classList.add('hidden');
      }
    }
  });

  window.addEventListener('drop', (e) => {
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      dragCounter = 0;
      if (dropZone) dropZone.classList.add('hidden');

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const file = files[0];
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target.result;
          document.getElementById('hikeCode').value = content;
          updateEditorGutter();
          syncEditorHighlight();
          updateWasmCodeDisplay();
          resetStepDebug();

          const msg = currentLang === 'ja'
            ? `[ファイル読込] ${file.name} (${file.size} バイト) をエディタに読み込みました。`
            : `[File Loaded] Loaded ${file.name} (${file.size} bytes) to editor.`;
          log(msg, 'success');
        };
        reader.readAsText(file);
      }
    }
  });
}

// イベントリスナー
document.getElementById('modeStandard').addEventListener('click', () => setMode('standard'));
document.getElementById('modeServer').addEventListener('click', () => setMode('server'));
document.getElementById('modeAdvanced').addEventListener('click', () => setMode('advanced'));

const btnSaveHikeEl = document.getElementById('btnSaveHike');
if (btnSaveHikeEl) btnSaveHikeEl.addEventListener('click', saveHikeSourceCode);

const btnExportWasmEl = document.getElementById('btnExportWasm');
if (btnExportWasmEl) btnExportWasmEl.addEventListener('click', exportWasmBinary);

const btnExportWatEl = document.getElementById('btnExportWat');
if (btnExportWatEl) btnExportWatEl.addEventListener('click', exportWatText);

const btnExportLlvmEl = document.getElementById('btnExportLlvm');
if (btnExportLlvmEl) btnExportLlvmEl.addEventListener('click', exportLlvmText);

document.getElementById('btnDebugStart').addEventListener('click', startStepDebug);
document.getElementById('btnDebugNext').addEventListener('click', nextStepDebug);
document.getElementById('btnDebugAutoStep').addEventListener('click', toggleAutoStepDebug);
document.getElementById('btnDebugContinue').addEventListener('click', continueStepDebug);
document.getElementById('btnDebugReset').addEventListener('click', resetStepDebug);
document.getElementById('btnRowsToggle').addEventListener('click', toggleMemoryRows);
document.getElementById('btnHexDecToggle').addEventListener('click', toggleHexDecMode);

const btnManualEl = document.getElementById('btnManual');
if (btnManualEl && btnManualEl.tagName === 'BUTTON') {
  btnManualEl.addEventListener('click', openManualModal);
}
const btnCloseManualEl = document.getElementById('btnCloseManualModal');
if (btnCloseManualEl) {
  btnCloseManualEl.addEventListener('click', closeManualModal);
}
document.getElementById('btnExercises').addEventListener('click', openExerciseModal);
document.getElementById('btnCloseModal').addEventListener('click', closeExerciseModal);

// モーダル背景クリック時も閉じる処理
const exerciseModalEl = document.getElementById('exerciseModal');
if (exerciseModalEl) {
  exerciseModalEl.addEventListener('click', (e) => {
    if (e.target === exerciseModalEl) closeExerciseModal();
  });
}
const manualModalEl = document.getElementById('manualModal');
if (manualModalEl) {
  manualModalEl.addEventListener('click', (e) => {
    if (e.target === manualModalEl) closeManualModal();
  });
}

document.querySelectorAll('.btn-load-ex').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const btnEl = e.target.closest('.btn-load-ex') || e.currentTarget || e.target;
    const key = btnEl.getAttribute('data-ex');
    loadExercise(key);
  });
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-load-ex, [data-ex]');
  if (btn) {
    const key = btn.getAttribute('data-ex');
    if (key) {
      loadExercise(key);
    }
  }
});

document.getElementById('btnCompile').addEventListener('click', compileHike);
const btnCompileEditorEl = document.getElementById('btnCompileEditor');
if (btnCompileEditorEl) {
  btnCompileEditorEl.addEventListener('click', compileHike);
}
document.getElementById('btnRun').addEventListener('click', runWasm);
document.getElementById('btnClearConsole').addEventListener('click', clearConsole);

const btnThemeToggleEl = document.getElementById('btnThemeToggle');
if (btnThemeToggleEl) btnThemeToggleEl.addEventListener('click', toggleTheme);

document.getElementById('btnLangToggle').addEventListener('click', () => {
  const nextLang = currentLang === 'ja' ? 'en' : 'ja';
  applyLanguage(nextLang);
});

// パネルのドラッグ＆ドロップ入れ替えおよび折りたたみ（たたみ）制御の初期化
function initPanelInteractions() {
  const panels = document.querySelectorAll('.panel');
  let draggedPanel = null;
  const cellClasses = [
    'cell-top-left', 'cell-top-right', 'cell-bottom-left', 'cell-bottom-right',
    'cell-span-left', 'cell-span-right', 'cell-span-top', 'cell-span-bottom',
    'cell-span-row2', 'cell-span-row3', 'cell-span-row4', 'cell-row4-left', 'cell-row4-right',
    'cell-span-row5', 'cell-row5-left', 'cell-row5-right'
  ];

  panels.forEach(panel => {
    // 1. ドラッグ開始
    panel.addEventListener('dragstart', (e) => {
      // エディタテキスト選択や各種ボタン・セレクト要素でのドラッグ誤動作を防止
      const tag = e.target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || e.target.closest('.editor-gutter')) {
        e.preventDefault();
        return;
      }

      draggedPanel = panel;
      panel.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', panel.id);
      }
    });

    // 2. ドラッグ終了
    panel.addEventListener('dragend', () => {
      panel.classList.remove('dragging');
      panels.forEach(p => p.classList.remove('drag-over'));
      draggedPanel = null;
    });

    // 3. ドラッグオーバー
    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (draggedPanel && draggedPanel !== panel) {
        panel.classList.add('drag-over');
      }
    });

    // 4. ドラッグリーブ
    panel.addEventListener('dragleave', () => {
      panel.classList.remove('drag-over');
    });

    // 5. ドロップ (グリッドセルの位置 & 表示状態の完全入れ替え)
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('drag-over');

      if (draggedPanel && draggedPanel !== panel) {
        const draggedCell = cellClasses.find(c => draggedPanel.classList.contains(c)) || '';
        const targetCell = cellClasses.find(c => panel.classList.contains(c)) || '';

        const draggedDisplay = draggedPanel.style.display;
        const targetDisplay = panel.style.display;

        // 格納位置(セルCSSクラス)の入れ替え
        if (draggedCell) draggedPanel.classList.remove(draggedCell);
        if (targetCell) panel.classList.remove(targetCell);

        if (targetCell) draggedPanel.classList.add(targetCell);
        if (draggedCell) panel.classList.add(draggedCell);

        // 表示スタイル(display)の入れ替え
        draggedPanel.style.display = targetDisplay;
        panel.style.display = draggedDisplay;

        // パネルヘッダーのセレクトボックス表示の同期
        syncPanelHeaderSelects();
        resetAutoToggleCounters();
        setTimeout(checkAllHeaderOverflows, 50);

        const selectA = draggedPanel.querySelector('.panel-content-select');
        const selectB = panel.querySelector('.panel-content-select');
        const titleA = selectA && selectA.options[selectA.selectedIndex] ? selectA.options[selectA.selectedIndex].textContent : draggedPanel.id;
        const titleB = selectB && selectB.options[selectB.selectedIndex] ? selectB.options[selectB.selectedIndex].textContent : panel.id;

        const msg = currentLang === 'ja'
          ? `[レイアウト] 「${titleA}」と「${titleB}」の枠位置を入れ替えました。`
          : `[Layout] Swapped positions of "${titleA}" and "${titleB}".`;
        log(msg, 'info');
      }
    });

    // 6. 折りたたみ (ヘッダーダブルクリック または ➖/➕ ボタン)
    const header = panel.querySelector('.panel-header');
    const toggleBtn = panel.querySelector('.btn-panel-toggle');

    const toggleCollapse = (e) => {
      if (e && e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && !e.target.classList.contains('btn-panel-toggle')) {
        return;
      }
      
      panel.classList.remove('auto-overflow-collapsed');
      const isCollapsed = panel.classList.toggle('collapsed');
      if (toggleBtn) {
        toggleBtn.textContent = isCollapsed ? '➕' : '➖';
      }
      const titleSpan = panel.querySelector('.panel-title-wrapper span[data-i18n]') || panel.querySelector('.panel-title-wrapper span');
      const title = titleSpan ? titleSpan.textContent : panel.id;
      const statusStr = isCollapsed
        ? (currentLang === 'ja' ? '折りたたみました' : 'collapsed')
        : (currentLang === 'ja' ? '展開しました' : 'expanded');
      log(`[パネル操作] ${title} を${statusStr}。`, 'info');
    };

    if (header) {
      header.addEventListener('dblclick', toggleCollapse);
    }
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse(null);
      });
    }
  });
}

// 壁（スプリッター）のドラッグ移動 & ある程度小さくなったら自動たたむ機能
function initSplitterInteractions() {
  const container = document.getElementById('panelContainer');
  const splitterV = document.getElementById('splitterV');
  const splitterH = document.getElementById('splitterH');
  const splitterH2 = document.getElementById('splitterH2');
  const splitterIntersection = document.getElementById('splitterIntersection');

  let isDraggingV = false;
  let isDraggingH = false;
  let isDraggingH2 = false;
  let isDraggingCenter = false;

  let autoCollapsedTop = false;
  let autoCollapsedBottom = false;
  let autoCollapsedLeft = false;
  let autoCollapsedRight = false;

  const updateLayout = (clientX, clientY, dragMode) => {
    if (!container) return;
    const rect = container.getBoundingClientRect();

    // 垂直壁 (左右ドラッグ)
    if (dragMode === 'v' || dragMode === 'center') {
      let xPct = ((clientX - rect.left) / rect.width) * 100;
      xPct = Math.max(3, Math.min(97, xPct));
      container.style.setProperty('--col-left', `${xPct}%`);
      container.style.setProperty('--col-right', `${100 - xPct}%`);

      // 左壁が 10% 以下になったらたたむ (13% 以上で復元して点滅防止)
      if (xPct <= 10) {
        if (!autoCollapsedLeft) {
          autoCollapsedLeft = true;
          document.querySelectorAll('.cell-top-left, .cell-bottom-left').forEach(p => {
            p.classList.add('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➕';
          });
          log(currentLang === 'ja' ? '[自動最小化] 幅10%以下のため左側パネルを折りたたみました。' : '[Auto Minimize] Left panels auto-collapsed (≤10%).', 'info');
        }
      } else if (xPct >= 13) {
        if (autoCollapsedLeft) {
          autoCollapsedLeft = false;
          document.querySelectorAll('.cell-top-left, .cell-bottom-left').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➖';
          });
        }
      }

      // 右壁が 10% 以下になったらたたむ (87% 以下で復元して点滅防止)
      if (xPct >= 90) {
        if (!autoCollapsedRight) {
          autoCollapsedRight = true;
          document.querySelectorAll('.cell-top-right, .cell-bottom-right').forEach(p => {
            p.classList.add('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➕';
          });
          log(currentLang === 'ja' ? '[自動最小化] 幅10%以下のため右側パネルを折りたたみました。' : '[Auto Minimize] Right panels auto-collapsed (≤10%).', 'info');
        }
      } else if (xPct <= 87) {
        if (autoCollapsedRight) {
          autoCollapsedRight = false;
          document.querySelectorAll('.cell-top-right, .cell-bottom-right').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➖';
          });
        }
      }
    }

    // 主水平壁 (上下ドラッグ)
    if (dragMode === 'h' || dragMode === 'center') {
      let yPct = ((clientY - rect.top) / rect.height) * 100;
      yPct = Math.max(3, Math.min(97, yPct));
      container.style.setProperty('--row-top', `${yPct}%`);
      container.style.setProperty('--row-bottom', `${100 - yPct}%`);

      // 上壁が 10% 以下になったらたたむ (13% 以上で復元)
      if (yPct <= 10) {
        if (!autoCollapsedTop) {
          autoCollapsedTop = true;
          document.querySelectorAll('.cell-top-left, .cell-top-right').forEach(p => {
            p.classList.add('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➕';
          });
          log(currentLang === 'ja' ? '[自動最小化] 高さ10%以下のため上側パネルを折りたたみました。' : '[Auto Minimize] Top panels auto-collapsed (≤10%).', 'info');
        }
      } else if (yPct >= 13) {
        if (autoCollapsedTop) {
          autoCollapsedTop = false;
          document.querySelectorAll('.cell-top-left, .cell-top-right').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➖';
          });
        }
      }

      // 下壁が 10% 以下になったらたたむ (87% 以下で復元)
      if (yPct >= 90) {
        if (!autoCollapsedBottom) {
          autoCollapsedBottom = true;
          document.querySelectorAll('.cell-bottom-left, .cell-bottom-right').forEach(p => {
            p.classList.add('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➕';
          });
          log(currentLang === 'ja' ? '[自動最小化] 高さ10%以下のため下側パネルを折りたたみました。' : '[Auto Minimize] Bottom panels auto-collapsed (≤10%).', 'info');
        }
      } else if (yPct <= 87) {
        if (autoCollapsedBottom) {
          autoCollapsedBottom = false;
          document.querySelectorAll('.cell-bottom-left, .cell-bottom-right').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '➖';
          });
        }
      }
    }

    // サブ水平壁 (h2: 2段縦の境目をドラッグ)
    if (dragMode === 'h2') {
      const selectEl = document.getElementById('selectLayoutPreset');
      const preset = selectEl ? selectEl.value : '4';

      if (preset === '4tb') {
        const rowTopStyle = getComputedStyle(container).getPropertyValue('--row-top') || '50%';
        const rowTopPct = parseFloat(rowTopStyle) || 50;
        const topPx = rect.height * (rowTopPct / 100);
        const bottomPx = rect.height - topPx - 8;

        if (bottomPx > 40) {
          let relY = clientY - (rect.top + topPx + 8);
          let sub1Pct = (relY / bottomPx) * 100;
          sub1Pct = Math.max(10, Math.min(90, sub1Pct));
          container.style.setProperty('--row-sub1', `${sub1Pct}fr`);
          container.style.setProperty('--row-sub2', `${100 - sub1Pct}fr`);
        }
      } else if (preset === '4bt') {
        const rowBottomStyle = getComputedStyle(container).getPropertyValue('--row-bottom') || '50%';
        const rowBottomPct = parseFloat(rowBottomStyle) || 50;
        const topPx = rect.height * ((100 - rowBottomPct) / 100);

        if (topPx > 40) {
          let relY = clientY - rect.top;
          let sub1Pct = (relY / topPx) * 100;
          sub1Pct = Math.max(10, Math.min(90, sub1Pct));
          container.style.setProperty('--row-sub1', `${sub1Pct}fr`);
          container.style.setProperty('--row-sub2', `${100 - sub1Pct}fr`);
        }
      }
    }

    checkAllHeaderOverflows();
  };

  const onPointerDown = (e, mode) => {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    resetAutoToggleCounters();
    if (mode === 'v' && splitterV) { isDraggingV = true; splitterV.classList.add('active'); }
    if (mode === 'h' && splitterH) { isDraggingH = true; splitterH.classList.add('active'); }
    if (mode === 'h2' && splitterH2) { isDraggingH2 = true; splitterH2.classList.add('active'); }
    if (mode === 'center' && splitterIntersection) { isDraggingCenter = true; splitterIntersection.classList.add('active'); }
    document.body.style.userSelect = 'none';
  };

  if (splitterV) splitterV.addEventListener('mousedown', (e) => onPointerDown(e, 'v'));
  if (splitterH) splitterH.addEventListener('mousedown', (e) => onPointerDown(e, 'h'));
  if (splitterH2) splitterH2.addEventListener('mousedown', (e) => onPointerDown(e, 'h2'));
  if (splitterIntersection) splitterIntersection.addEventListener('mousedown', (e) => onPointerDown(e, 'center'));

  // タッチ操作サポート
  if (splitterV) splitterV.addEventListener('touchstart', (e) => { if (e && e.cancelable) e.preventDefault(); onPointerDown(e, 'v'); }, { passive: false });
  if (splitterH) splitterH.addEventListener('touchstart', (e) => { if (e && e.cancelable) e.preventDefault(); onPointerDown(e, 'h'); }, { passive: false });
  if (splitterH2) splitterH2.addEventListener('touchstart', (e) => { if (e && e.cancelable) e.preventDefault(); onPointerDown(e, 'h2'); }, { passive: false });
  if (splitterIntersection) splitterIntersection.addEventListener('touchstart', (e) => { if (e && e.cancelable) e.preventDefault(); onPointerDown(e, 'center'); }, { passive: false });

  window.addEventListener('mousemove', (e) => {
    if (isDraggingV) updateLayout(e.clientX, e.clientY, 'v');
    if (isDraggingH) updateLayout(e.clientX, e.clientY, 'h');
    if (isDraggingH2) updateLayout(e.clientX, e.clientY, 'h2');
    if (isDraggingCenter) updateLayout(e.clientX, e.clientY, 'center');
  });

  window.addEventListener('touchmove', (e) => {
    if (isDraggingV) updateLayout(e.touches[0].clientX, e.touches[0].clientY, 'v');
    if (isDraggingH) updateLayout(e.touches[0].clientX, e.touches[0].clientY, 'h');
    if (isDraggingH2) updateLayout(e.touches[0].clientX, e.touches[0].clientY, 'h2');
    if (isDraggingCenter) updateLayout(e.touches[0].clientX, e.touches[0].clientY, 'center');
  });

  const onPointerUp = () => {
    if (isDraggingV || isDraggingH || isDraggingH2 || isDraggingCenter) {
      isDraggingV = false;
      isDraggingH = false;
      isDraggingH2 = false;
      isDraggingCenter = false;
      if (splitterV) splitterV.classList.remove('active');
      if (splitterH) splitterH.classList.remove('active');
      if (splitterH2) splitterH2.classList.remove('active');
      if (splitterIntersection) splitterIntersection.classList.remove('active');
      document.body.style.userSelect = '';
      checkAllHeaderOverflows();
    }
  };

  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('touchend', onPointerUp);
}

let consecutiveToggleCounts = {
  'panel-editor': 0,
  'panel-wasm': 0,
  'panel-console': 0,
  'panel-memory': 0
};

function resetAutoToggleCounters() {
  for (let key in consecutiveToggleCounts) {
    consecutiveToggleCounts[key] = 0;
  }
}

// ヘッダーナビゲーションの自動畳み込み (三点リーダー ⋮ メニュー化) 制御
function setupResponsiveHeaders() {
  const wrappers = document.querySelectorAll('.panel-actions-wrapper, .controls-wrapper');

  wrappers.forEach(wrapper => {
    const inlineGroup = wrapper.querySelector('.nav-inline-group');
    const moreBtn = wrapper.querySelector('.btn-more-menu');
    const dropdown = wrapper.querySelector('.nav-dropdown');

    if (!inlineGroup || !moreBtn || !dropdown) return;

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.nav-dropdown').forEach(d => {
        if (d !== dropdown) d.classList.add('hidden');
      });
      
      buildDropdownMenu(inlineGroup, dropdown);
      dropdown.classList.toggle('hidden');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.add('hidden'));
  });

  window.addEventListener('resize', () => {
    resetAutoToggleCounters();
    checkAllHeaderOverflows();
  });
}

function buildDropdownMenu(inlineGroup, dropdown) {
  dropdown.innerHTML = '';
  const items = inlineGroup.querySelectorAll('button, a, select');

  items.forEach(item => {
    if (item.classList.contains('hidden') || item.style.display === 'none') return;

    if (item.tagName === 'SELECT') {
      Array.from(item.options).forEach(opt => {
        const menuItem = document.createElement('button');
        menuItem.className = 'dropdown-item';
        menuItem.innerHTML = `${opt.textContent}${opt.value === item.value ? ' ✓' : ''}`;
        menuItem.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.add('hidden');
          item.value = opt.value;
          item.dispatchEvent(new Event('change'));
        });
        dropdown.appendChild(menuItem);
      });
      return;
    }
    
    const menuItem = document.createElement('button');
    menuItem.className = 'dropdown-item';
    menuItem.innerHTML = item.innerHTML;
    if (item.hasAttribute('title')) menuItem.title = item.getAttribute('title');
    if (item.disabled) menuItem.disabled = true;

    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.add('hidden');
      item.click();
    });

    dropdown.appendChild(menuItem);
  });
}

function checkAllHeaderOverflows() {
  const wrappers = document.querySelectorAll('.panel-actions-wrapper, .controls-wrapper');

  wrappers.forEach(wrapper => {
    const inlineGroup = wrapper.querySelector('.nav-inline-group');
    const moreBtn = wrapper.querySelector('.btn-more-menu');
    const dropdown = wrapper.querySelector('.nav-dropdown');

    if (!inlineGroup || !moreBtn) return;

    const parent = wrapper.parentElement;
    if (!parent) return;

    const panel = wrapper.closest('.panel');
    const headerWidth = parent.clientWidth;

    // 1. 三点リーダー ⋮ メニュー表示制御
    if (!inlineGroup.classList.contains('collapsed-nav')) {
      const buttons = inlineGroup.querySelectorAll('button, a, select');
      if (buttons.length > 0) {
        const firstTop = buttons[0].offsetTop;
        const lastTop = buttons[buttons.length - 1].offsetTop;
        if (lastTop > firstTop + 4 || headerWidth < 250) {
          inlineGroup.classList.add('collapsed-nav');
          moreBtn.classList.remove('hidden');
        }
      }
    } else {
      if (headerWidth > 310) {
        inlineGroup.classList.remove('collapsed-nav');
        moreBtn.classList.add('hidden');
        if (dropdown) dropdown.classList.add('hidden');
      }
    }

    // 2. 枠全体の自動折りたたみ制御 (連続2回以上の開閉でループ安全装置を発動し完全停止)
    if (panel) {
      const panelId = panel.id || 'default';
      const isAutoCollapsed = panel.classList.contains('auto-overflow-collapsed');
      const count = consecutiveToggleCounts[panelId] || 0;

      if (count < 2) {
        if (!isAutoCollapsed && headerWidth < 210) {
          consecutiveToggleCounts[panelId] = count + 1;
          panel.classList.add('collapsed', 'auto-overflow-collapsed');
          const toggleBtn = panel.querySelector('.btn-panel-toggle');
          if (toggleBtn) toggleBtn.textContent = '➕';
        } else if (isAutoCollapsed && headerWidth > 270) {
          consecutiveToggleCounts[panelId] = count + 1;
          panel.classList.remove('collapsed', 'auto-overflow-collapsed');
          const toggleBtn = panel.querySelector('.btn-panel-toggle');
          if (toggleBtn) toggleBtn.textContent = '➖';
        }
      }
    }
  });
}

const ALL_CELL_CLASSES = [
  'cell-top-left', 'cell-top-right', 'cell-bottom-left', 'cell-bottom-right',
  'cell-span-left', 'cell-span-right', 'cell-span-top', 'cell-span-bottom',
  'cell-span-row2', 'cell-span-row3', 'cell-span-row4', 'cell-row4-left', 'cell-row4-right',
  'cell-span-row5', 'cell-row5-left', 'cell-row5-right'
];

function removeAllCellClasses(el) {
  if (!el) return;
  ALL_CELL_CLASSES.forEach(c => el.classList.remove(c));
}

// 枠ごとのコンテンツ切り替えマッピング制御
const panelTypeToIdMap = {
  'editor': 'panel-editor',
  'llvm': 'panel-llvm',
  'wasm': 'panel-wasm',
  'console': 'panel-console',
  'memory': 'panel-memory'
};

const panelIdToTypeMap = {
  'panel-editor': 'editor',
  'panel-llvm': 'llvm',
  'panel-wasm': 'wasm',
  'panel-console': 'console',
  'panel-memory': 'memory'
};

function swapPanelContent(sourcePanelId, targetType) {
  const sourceType = panelIdToTypeMap[sourcePanelId];
  if (sourceType === targetType) return;

  const targetPanelId = panelTypeToIdMap[targetType];
  const sourcePanel = document.getElementById(sourcePanelId);
  const targetPanel = document.getElementById(targetPanelId);

  if (!sourcePanel || !targetPanel) return;

  const sourceCell = ALL_CELL_CLASSES.find(c => sourcePanel.classList.contains(c)) || '';
  const targetCell = ALL_CELL_CLASSES.find(c => targetPanel.classList.contains(c)) || '';

  const sourceDisplay = sourcePanel.style.display;
  const targetDisplay = targetPanel.style.display;

  removeAllCellClasses(sourcePanel);
  removeAllCellClasses(targetPanel);

  if (targetCell) sourcePanel.classList.add(targetCell);
  if (sourceCell) targetPanel.classList.add(sourceCell);

  sourcePanel.style.display = targetDisplay;
  targetPanel.style.display = sourceDisplay;

  syncPanelHeaderSelects();

  resetAutoToggleCounters();
  setTimeout(checkAllHeaderOverflows, 50);

  const typeNames = {
    'editor': '📄 main.hike (エディタ)',
    'llvm': '📜 LLVM IR',
    'wasm': '⚙️ WASM (WAT)',
    'console': '💻 コンソール',
    'memory': '🔍 リニアメモリ'
  };
  log(currentLang === 'ja' ? `[枠表示切替] ${typeNames[targetType]} の表示位置を変更しました。` : `[Panel Content] Switched ${typeNames[targetType]} position.`, 'info');
}

function syncPanelHeaderSelects() {
  document.querySelectorAll('.panel-content-select').forEach(select => {
    const pId = select.getAttribute('data-panel-id');
    const type = panelIdToTypeMap[pId];
    if (type && select.value !== type) {
      select.value = type;
    }
  });
}

// 枠数レイアウト（4枠 / 3枠 / 2枠 / 1枠）プリセット切り替え関数
function applyLayoutPreset(preset) {
  const container = document.getElementById('panelContainer');
  const editor = document.getElementById('panel-editor');
  const llvm = document.getElementById('panel-llvm');
  const wasm = document.getElementById('panel-wasm');
  const consoleP = document.getElementById('panel-console');
  const memory = document.getElementById('panel-memory');

  const splitterV = document.getElementById('splitterV');
  const splitterH = document.getElementById('splitterH');
  const splitterH2 = document.getElementById('splitterH2');
  const splitterIntersection = document.getElementById('splitterIntersection');

  if (!container || !editor || !llvm || !wasm || !consoleP || !memory) return;

  container.style.gridTemplateColumns = '';
  container.style.gridTemplateRows = '';

  const allPanels = [editor, llvm, wasm, consoleP, memory];
  allPanels.forEach(p => {
    p.style.display = '';
    removeAllCellClasses(p);
    p.classList.remove('collapsed', 'auto-overflow-collapsed');
    const toggleBtn = p.querySelector('.btn-panel-toggle');
    if (toggleBtn) toggleBtn.textContent = '➖';
  });

  if (splitterV) {
    splitterV.style.display = '';
    splitterV.className = 'splitter splitter-v';
  }
  if (splitterH) {
    splitterH.style.display = '';
    splitterH.className = 'splitter splitter-h';
  }
  if (splitterH2) {
    splitterH2.style.display = 'none';
  }
  if (splitterIntersection) splitterIntersection.style.display = '';

  const selectEl = document.getElementById('selectLayoutPreset');
  if (selectEl && selectEl.value !== preset) selectEl.value = preset;

  if (preset === '4') {
    // 4枠表示 (標準 2x2: エディタ, WASM, コンソール, メモリ)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '50%');
    container.style.setProperty('--row-bottom', '50%');

    editor.className = 'panel cell-top-left';
    wasm.className = 'panel cell-top-right';
    consoleP.className = 'panel cell-bottom-left';
    memory.className = 'panel cell-bottom-right';
    llvm.style.display = 'none';

  } else if (preset === '4tb') {
    // 4枠 (上2横 : 下2段縦 -> 上側は左右2枠、下側は上下2段)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '40%');
    container.style.setProperty('--row-bottom', '60%');
    container.style.gridTemplateRows = 'var(--row-top, 40%) 8px var(--row-sub1, 1fr) 8px var(--row-sub2, 1fr)';

    editor.className = 'panel cell-top-left';
    wasm.className = 'panel cell-top-right';
    consoleP.className = 'panel cell-span-row3';
    memory.className = 'panel cell-span-row5';
    llvm.style.display = 'none';

    if (splitterV) splitterV.className = 'splitter splitter-v-top';
    if (splitterH) splitterH.className = 'splitter splitter-h';
    if (splitterH2) {
      splitterH2.style.display = '';
      splitterH2.className = 'splitter splitter-h';
      splitterH2.style.gridColumn = '1 / span 3';
      splitterH2.style.gridRow = '4';
    }
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '4bt') {
    // 4枠 (上2段縦 : 下2横 -> 上側は上下2段、下側は左右2枠)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '60%');
    container.style.setProperty('--row-bottom', '40%');
    container.style.gridTemplateRows = 'var(--row-sub1, 1fr) 8px var(--row-sub2, 1fr) 8px var(--row-bottom, 40%)';

    editor.className = 'panel cell-span-top';
    wasm.className = 'panel cell-span-row3';
    consoleP.className = 'panel cell-row5-left';
    memory.className = 'panel cell-row5-right';
    llvm.style.display = 'none';

    if (splitterV) splitterV.className = 'splitter splitter-v-bottom';
    if (splitterH) splitterH.className = 'splitter splitter-h';
    if (splitterH2) {
      splitterH2.style.display = '';
      splitterH2.className = 'splitter splitter-h';
      splitterH2.style.gridColumn = '1 / span 3';
      splitterH2.style.gridRow = '2';
    }
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '3l') {
    // 3枠 (左1:右2 -> 左側1大枠, 右側上下2枠)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '50%');
    container.style.setProperty('--row-bottom', '50%');

    editor.className = 'panel cell-span-left';
    wasm.className = 'panel cell-top-right';
    consoleP.className = 'panel cell-bottom-right';
    llvm.style.display = 'none';
    memory.style.display = 'none';

    if (splitterV) splitterV.className = 'splitter splitter-v';
    if (splitterH) splitterH.className = 'splitter splitter-h-right';
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '3r') {
    // 3枠 (左2:右1 -> 左側上下2枠, 右側1大枠)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '50%');
    container.style.setProperty('--row-bottom', '50%');

    editor.className = 'panel cell-top-left';
    consoleP.className = 'panel cell-bottom-left';
    wasm.className = 'panel cell-span-right';
    llvm.style.display = 'none';
    memory.style.display = 'none';

    if (splitterV) splitterV.className = 'splitter splitter-v';
    if (splitterH) splitterH.className = 'splitter splitter-h-left';
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '3t') {
    // 3枠 (上1:下2 -> 上側1大枠, 下側左右2枠)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '50%');
    container.style.setProperty('--row-bottom', '50%');

    editor.className = 'panel cell-span-top';
    wasm.className = 'panel cell-bottom-left';
    consoleP.className = 'panel cell-bottom-right';
    llvm.style.display = 'none';
    memory.style.display = 'none';

    if (splitterH) splitterH.className = 'splitter splitter-h';
    if (splitterV) splitterV.className = 'splitter splitter-v-bottom';
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '3b') {
    // 3枠 (上2:下1 -> 上側左右2枠, 下側1大枠)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '50%');
    container.style.setProperty('--row-bottom', '50%');

    editor.className = 'panel cell-top-left';
    wasm.className = 'panel cell-top-right';
    consoleP.className = 'panel cell-span-bottom';
    llvm.style.display = 'none';
    memory.style.display = 'none';

    if (splitterH) splitterH.className = 'splitter splitter-h';
    if (splitterV) splitterV.className = 'splitter splitter-v-top';
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '2h') {
    // 2枠 (左右)
    container.style.setProperty('--col-left', '50%');
    container.style.setProperty('--col-right', '50%');
    container.style.setProperty('--row-top', '100%');
    container.style.setProperty('--row-bottom', '0%');

    editor.className = 'panel cell-top-left';
    wasm.className = 'panel cell-top-right';
    llvm.style.display = 'none';
    consoleP.style.display = 'none';
    memory.style.display = 'none';

    if (splitterH) splitterH.style.display = 'none';
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '2v') {
    // 2枠 (上下)
    container.style.setProperty('--col-left', '100%');
    container.style.setProperty('--col-right', '0%');
    container.style.setProperty('--row-top', '50%');
    container.style.setProperty('--row-bottom', '50%');

    editor.className = 'panel cell-top-left';
    consoleP.className = 'panel cell-bottom-left';
    llvm.style.display = 'none';
    wasm.style.display = 'none';
    memory.style.display = 'none';

    if (splitterV) splitterV.style.display = 'none';
    if (splitterIntersection) splitterIntersection.style.display = 'none';

  } else if (preset === '1') {
    // 1枠 (全画面)
    container.style.setProperty('--col-left', '100%');
    container.style.setProperty('--col-right', '0%');
    container.style.setProperty('--row-top', '100%');
    container.style.setProperty('--row-bottom', '0%');

    editor.className = 'panel cell-top-left';
    llvm.style.display = 'none';
    wasm.style.display = 'none';
    consoleP.style.display = 'none';
    memory.style.display = 'none';

    if (splitterV) splitterV.style.display = 'none';
    if (splitterH) splitterH.style.display = 'none';
    if (splitterIntersection) splitterIntersection.style.display = 'none';
  }

  syncPanelHeaderSelects();
  resetAutoToggleCounters();
  setTimeout(checkAllHeaderOverflows, 80);

  const presetNames = {
    '4': '4枠 (2×2)',
    '4tb': '4枠 (上2・下縦)',
    '4bt': '4枠 (上縦・下2)',
    '3l': '3枠 (左1・右2)',
    '3r': '3枠 (左2・右1)',
    '3t': '3枠 (上1・下2)',
    '3b': '3枠 (上2・下1)',
    '2h': '2枠 (左右)',
    '2v': '2枠 (上下)',
    '1': '1枠 (全画面)'
  };
  log(currentLang === 'ja' ? `[レイアウト変更] ${presetNames[preset]} に切り替えました。` : `[Layout] Switched layout preset to ${presetNames[preset]}.`, 'info');
}

// 標準レイアウトへの復元関数
function resetPanelLayout() {
  applyLayoutPreset('4');
}

// イベントリスナー追加
const selectLayoutPresetEl = document.getElementById('selectLayoutPreset');
if (selectLayoutPresetEl) {
  selectLayoutPresetEl.addEventListener('change', (e) => {
    applyLayoutPreset(e.target.value);
  });
}
document.getElementById('btnResetLayout').addEventListener('click', resetPanelLayout);

document.querySelectorAll('.panel-content-select').forEach(select => {
  select.addEventListener('change', (e) => {
    const pId = e.target.getAttribute('data-panel-id');
    const targetType = e.target.value;
    swapPanelContent(pId, targetType);
  });
});

// 初期起動
applyLanguage('ja');
applyTheme(currentTheme);
updateEditorGutter();
syncEditorHighlight();
updateMemoryGridDisplay();
updateWasmCodeDisplay(true);
applyLayoutPreset('4');
initPanelInteractions();
initSplitterInteractions();
setupResponsiveHeaders();
initFileDragAndDrop();
initMarkerMode();
setTimeout(checkAllHeaderOverflows, 100);

// ==========================================
// クロスコード・マーカーモード (非実行時 薄青ハイライト連動)
// ==========================================
let isMarkerModeActive = false;

function toggleMarkerMode() {
  isMarkerModeActive = !isMarkerModeActive;
  const btn = document.getElementById('btnMarkerToggle');
  if (btn) {
    if (isMarkerModeActive) {
      btn.classList.add('on');
      log(currentLang === 'ja' ? '[マーカーモード] 薄青ハイライト連動を有効化しました。' : '[Marker Mode] Enabled cross-code soft blue highlighting.', 'info');
    } else {
      btn.classList.remove('on');
      clearMarkerHighlights();
      log(currentLang === 'ja' ? '[マーカーモード] 薄青ハイライト連動を無効化しました。' : '[Marker Mode] Disabled cross-code soft blue highlighting.', 'info');
    }
  }
}

function clearMarkerHighlights() {
  document.querySelectorAll('.active-marker-primary, .active-marker-linked, .active-marker-line').forEach(el => {
    el.classList.remove('active-marker-primary', 'active-marker-linked', 'active-marker-line');
  });
}

function syncMarkerHighlightTargetLines(step) {
  const llvmEl = document.getElementById('llvmCode');
  const wasmEl = document.getElementById('wasmCode');
  if (!step) return;

  // 将来用に内部ポインタとして記録
  currentExecutionPointer.snapshot = step;

  // マーカーオミット: WASM/LLVM IR パネル側へのクラス付与はスキップ
  if (OMIT_COMPILED_PANEL_MARKERS) {
    return;
  }

  const stepCode = (step.code || '').toLowerCase();
  const stepIsForHeader = stepCode.includes('for ') || stepCode.includes('while');
  const stepIsInsideLoop = !stepIsForHeader && (
    stepCode.includes('total = total +') || 
    stepCode.includes('arr[j]') || 
    (step.wasmMatch && (Array.isArray(step.wasmMatch) ? step.wasmMatch : [step.wasmMatch]).some(m => m.includes('i32.mul') || m.includes('i32.add') || m.includes('i32.sub') || m.includes('rem_s')))
  );

  if (llvmEl) {
    const llvmLines = Array.from(llvmEl.querySelectorAll('.code-line'));
    if (step.llvmMatch) {
      const matchPatterns = Array.isArray(step.llvmMatch) ? step.llvmMatch : [step.llvmMatch];
      let inLoopBlock = false;
      llvmLines.forEach(lineEl => {
        const text = lineEl.textContent;
        if (text.includes('for.body:') || text.includes('while.body:')) inLoopBlock = true;
        else if (text.startsWith('for.end:') || text.startsWith('while.end:')) inLoopBlock = false;

        if (stepIsInsideLoop && !inLoopBlock) return;
        if (!stepIsInsideLoop && !stepIsForHeader && inLoopBlock) return;

        matchPatterns.forEach(pat => {
          if (text.includes(pat)) lineEl.classList.add('active-marker-linked');
        });
      });
    }
  }

  if (wasmEl) {
    const wasmLines = Array.from(wasmEl.querySelectorAll('.code-line'));
    if (step.wasmMatch) {
      const matchPatterns = Array.isArray(step.wasmMatch) ? step.wasmMatch : [step.wasmMatch];
      let inLoop = false;
      wasmLines.forEach(lineEl => {
        const text = lineEl.textContent;
        if (text.includes('(loop')) inLoop = true;

        if (stepIsInsideLoop && !inLoop) return;
        if (!stepIsInsideLoop && !stepIsForHeader && inLoop) return;

        matchPatterns.forEach(pat => {
          if (text.includes(pat)) lineEl.classList.add('active-marker-linked');
        });

        if (inLoop && text.trim() === ')') inLoop = false;
      });
    }
  }
}

function updateMarkerHighlightsFromHikeLine(lineNum) {
  clearMarkerHighlights();
  if (!isMarkerModeActive || isDebugging) return;

  const hikeCodeEl = document.getElementById('hikeCode');
  if (!hikeCodeEl) return;
  const lines = hikeCodeEl.value.split('\n');
  if (lineNum < 1 || lineNum > lines.length) return;

  // 実行ポイント・行マーカーは HIKE コード側にのみ表示
  const gutterItem = document.querySelector(`.gutter-item[data-line="${lineNum}"]`);
  if (gutterItem) gutterItem.classList.add('active-marker-line');

  const lineText = lines[lineNum - 1].trim();
  if (!lineText) return;

  const dummyTrace = buildDynamicDebugTrace(hikeCodeEl.value);
  const matchedStep = dummyTrace.find(s => s.line === lineNum) || { code: lineText, line: lineNum };

  // 将来用に内部ポインタ情報を記録
  currentExecutionPointer.hikeLine = lineNum;
  currentExecutionPointer.snapshot = matchedStep;
  currentExecutionPointer.updatedAt = Date.now();

  syncMarkerHighlightTargetLines(matchedStep);
}

function updateMarkerHighlightsFromLlvmLine(lineEl) {
  clearMarkerHighlights();
  if (!isMarkerModeActive || isDebugging || !lineEl) return;

  if (!OMIT_COMPILED_PANEL_MARKERS) {
    lineEl.classList.add('active-marker-primary');
  }
  const txt = lineEl.textContent.trim().toLowerCase();
  if (!txt) return;

  const llvmEl = document.getElementById('llvmCode');
  const wasmEl = document.getElementById('wasmCode');
  const hikeCodeEl = document.getElementById('hikeCode');
  if (!hikeCodeEl || !llvmEl) return;

  const lines = hikeCodeEl.value.split('\n');
  const llvmLines = Array.from(llvmEl.querySelectorAll('.code-line'));
  const clickedIdx = llvmLines.indexOf(lineEl);

  let currentBlock = 'entry';
  for (let i = 0; i <= clickedIdx; i++) {
    const lTxt = llvmLines[i].textContent.trim().toLowerCase();
    if (lTxt.startsWith('for.cond:') || lTxt.startsWith('while.cond:')) {
      currentBlock = 'for.cond';
    } else if (lTxt.startsWith('for.body:') || lTxt.startsWith('while.body:')) {
      currentBlock = 'for.body';
    } else if (lTxt.startsWith('for.end:') || lTxt.startsWith('while.end:')) {
      currentBlock = 'for.end';
    }
  }

  let targetHikeLine = -1;
  const hikeLineAttr = lineEl.getAttribute('data-hike-line');

  if (hikeLineAttr) {
    targetHikeLine = parseInt(hikeLineAttr, 10);
  } else if (txt.includes('define i32 @gcd') || txt.includes('call i32 @gcd')) {
    targetHikeLine = lines.findIndex(l => l.includes('gcd(')) + 1;
  } else if (txt.includes('printf')) {
    targetHikeLine = lines.findIndex(l => l.includes('fmt.') || l.includes('Print') || l.includes('import')) + 1;
  } else if (txt.includes('define i32 @main') || txt.includes('define ') || txt.includes('entry:')) {
    targetHikeLine = lines.findIndex(l => l.includes('func main') || l.includes('func ')) + 1;
  } else if (txt.includes('ret i32') || txt.includes('ret ') || txt.includes('result = load')) {
    targetHikeLine = lines.findIndex(l => l.includes('return')) + 1;
  } else if (txt.includes('srem') || txt.includes('rem')) {
    targetHikeLine = lines.findIndex(l => l.includes('%') || l.includes('r :=')) + 1;
  } else if (txt.includes('sdiv') || txt.includes('div')) {
    targetHikeLine = lines.findIndex(l => l.includes('/') || l.includes('c :=')) + 1;
  } else if (currentBlock === 'for.cond' || txt.includes('for.cond') || txt.includes('icmp') || txt.includes('br i1')) {
    targetHikeLine = lines.findIndex(l => l.includes('for ')) + 1;
  } else if (txt.includes('arr[') || txt.includes('getelementptr') || txt.includes('xor') || txt.includes('struct') || currentBlock === 'for.body' || txt.includes('mul') || txt.includes('add') || txt.includes('store') || txt.includes('load')) {
    targetHikeLine = lines.findIndex(l => l.includes('total = total +') || l.includes('+') || l.includes('*')) + 1;
  } else if (txt.includes('%total = alloca') || txt.includes('store i32 0') || txt.includes('alloca')) {
    targetHikeLine = lines.findIndex(l => l.includes('var total') || l.includes('var ')) + 1;
  }

  if (targetHikeLine > 0) {
    const gutterItem = document.querySelector(`.gutter-item[data-line="${targetHikeLine}"]`);
    if (gutterItem) gutterItem.classList.add('active-marker-line');
    const dummyTrace = buildDynamicDebugTrace(hikeCodeEl.value);
    const matchedStep = dummyTrace.find(s => s.line === targetHikeLine) || { line: targetHikeLine, code: lines[targetHikeLine - 1] };
    currentExecutionPointer.hikeLine = targetHikeLine;
    currentExecutionPointer.snapshot = matchedStep;
    currentExecutionPointer.updatedAt = Date.now();
    syncMarkerHighlightTargetLines(matchedStep);
  }

  if (!OMIT_COMPILED_PANEL_MARKERS && wasmEl) {
    const wasmLines = Array.from(wasmEl.querySelectorAll('.code-line'));
    wasmLines.forEach(wEl => {
      const wTxt = wEl.textContent.toLowerCase();
      if ((txt.includes('srem') && wTxt.includes('i32.rem_s')) ||
          (txt.includes('sdiv') && wTxt.includes('i32.div_s')) ||
          ((currentBlock === 'for.body' || txt.includes('mul') || txt.includes('add') || txt.includes('load i32') || txt.includes('load')) && (wTxt.includes('i32.add') || wTxt.includes('i32.mul') || wTxt.includes('local.set $total') || wTxt.includes('local.get $total') || wTxt.includes('local.get $i'))) ||
          (currentBlock === 'for.cond' && (wTxt.includes('loop') || wTxt.includes('br_if') || wTxt.includes('i32.le_s'))) ||
          ((txt.includes('alloca') || txt.includes('store i32 0')) && (wTxt.includes('i32.const 0') || wTxt.includes('local.set $total'))) ||
          ((txt.includes('define') || txt.includes('entry')) && (wTxt.includes('func') || wTxt.includes('$main'))) ||
          ((txt.includes('ret i32') || txt.includes('ret')) && (wTxt.includes('return') || wTxt.includes('(result i32)') || wTxt.includes('result i32')))) {
        wEl.classList.add('active-marker-linked');
      }
    });
  }
}

function updateMarkerHighlightsFromWasmLine(lineEl) {
  clearMarkerHighlights();
  if (!isMarkerModeActive || isDebugging || !lineEl) return;

  if (!OMIT_COMPILED_PANEL_MARKERS) {
    lineEl.classList.add('active-marker-primary');
  }
  const txt = lineEl.textContent.trim().toLowerCase();
  if (!txt) return;

  const wasmEl = document.getElementById('wasmCode');
  const llvmEl = document.getElementById('llvmCode');
  const hikeCodeEl = document.getElementById('hikeCode');
  if (!hikeCodeEl || !wasmEl) return;

  const lines = hikeCodeEl.value.split('\n');
  const wasmLines = Array.from(wasmEl.querySelectorAll('.code-line'));
  const clickedIdx = wasmLines.indexOf(lineEl);

  let inLoop = false;
  let isLoopInc = false;

  for (let i = 0; i <= clickedIdx; i++) {
    const wTxt = wasmLines[i].textContent.trim().toLowerCase();
    if (wTxt.includes('(loop')) {
      inLoop = true;
    }
    if (inLoop && wTxt.includes('local.set $total')) {
      isLoopInc = true;
    }
    if (inLoop && wTxt === ')') {
      inLoop = false;
      isLoopInc = false;
    }
  }

  let targetHikeLine = -1;
  const hikeLineAttr = lineEl.getAttribute('data-hike-line');

  if (hikeLineAttr) {
    targetHikeLine = parseInt(hikeLineAttr, 10);
  } else if (txt.includes('call $gcd') || txt.includes('func $gcd')) {
    targetHikeLine = lines.findIndex(l => l.includes('gcd(')) + 1;
  } else if (txt.includes('print_int') || txt.includes('call $print_int')) {
    targetHikeLine = lines.findIndex(l => l.includes('fmt.') || l.includes('Print') || l.includes('import')) + 1;
  } else if (txt.includes('func $main') || txt.includes('(func') || txt.includes('(module')) {
    targetHikeLine = lines.findIndex(l => l.includes('func main') || l.includes('func ')) + 1;
  } else if (txt.includes('return') || txt.includes('(result i32)') || txt.includes('result i32') || (!inLoop && txt.includes('local.get $total'))) {
    targetHikeLine = lines.findIndex(l => l.includes('return')) + 1;
  } else if (txt.includes('i32.rem_s')) {
    targetHikeLine = lines.findIndex(l => l.includes('%') || l.includes('r :=')) + 1;
  } else if (txt.includes('i32.div_s')) {
    targetHikeLine = lines.findIndex(l => l.includes('/') || l.includes('c :=')) + 1;
  } else if (inLoop && (isLoopInc || txt.includes('i32.const 1') || txt.includes('i32.const 5') || txt.includes('i32.le_s') || txt.includes('br_if') || txt.includes('loop'))) {
    targetHikeLine = lines.findIndex(l => l.includes('for ')) + 1;
  } else if (inLoop && (txt.includes('i32.mul') || txt.includes('i32.const 10') || txt.includes('local.set $total') || txt.includes('local.get $total') || txt.includes('i32.add'))) {
    targetHikeLine = lines.findIndex(l => l.includes('total = total +') || l.includes('+') || l.includes('*')) + 1;
  } else if (!inLoop && (txt.includes('i32.const 0') || txt.includes('local $total') || txt.includes('local.set $total'))) {
    targetHikeLine = lines.findIndex(l => l.includes('var total') || l.includes('var ')) + 1;
  } else if (!inLoop && (txt.includes('i32.const 1') || txt.includes('local.set $i') || txt.includes('local $i'))) {
    targetHikeLine = lines.findIndex(l => l.includes('for ')) + 1;
  }

  if (targetHikeLine > 0) {
    const gutterItem = document.querySelector(`.gutter-item[data-line="${targetHikeLine}"]`);
    if (gutterItem) gutterItem.classList.add('active-marker-line');
    const dummyTrace = buildDynamicDebugTrace(hikeCodeEl.value);
    const matchedStep = dummyTrace.find(s => s.line === targetHikeLine) || { line: targetHikeLine, code: lines[targetHikeLine - 1] };
    currentExecutionPointer.hikeLine = targetHikeLine;
    currentExecutionPointer.snapshot = matchedStep;
    currentExecutionPointer.updatedAt = Date.now();
    syncMarkerHighlightTargetLines(matchedStep);
  }

  if (!OMIT_COMPILED_PANEL_MARKERS && llvmEl) {
    const llvmLines = Array.from(llvmEl.querySelectorAll('.code-line'));
    llvmLines.forEach(lEl => {
      const lTxt = lEl.textContent.toLowerCase();
      if ((txt.includes('i32.rem_s') && lTxt.includes('srem')) ||
          (txt.includes('i32.div_s') && lTxt.includes('sdiv')) ||
          (((txt.includes('call $log') || txt.includes('i32.store') || txt.includes('i32.load') || txt.includes('i32.xor')) && (lTxt.includes('printf') || lTxt.includes('getelementptr') || lTxt.includes('store') || lTxt.includes('xor'))) || (inLoop && (txt.includes('i32.mul') || txt.includes('i32.const 10') || txt.includes('local.get $total') || txt.includes('local.get $i') || txt.includes('local.set $total') || txt.includes('i32.add')) && (lTxt.includes('mul') || lTxt.includes('add') || lTxt.includes('load i32') || lTxt.includes('load') || lTxt.includes('for.body')))) ||
          (inLoop && (txt.includes('i32.le_s') || txt.includes('loop') || txt.includes('br_if') || isLoopInc) && (lTxt.includes('icmp') || lTxt.includes('for.cond') || lTxt.includes('for.inc'))) ||
          (!inLoop && (txt.includes('i32.const 0') || txt.includes('local $total')) && (lTxt.includes('alloca') || lTxt.includes('store i32 0'))) ||
          ((txt.includes('func') || txt.includes('$main') || txt.includes('module')) && (lTxt.includes('define') || lTxt.includes('entry'))) ||
          ((txt.includes('return') || txt.includes('(result i32)') || txt.includes('result i32')) && (lTxt.includes('ret i32') || lTxt.includes('ret')))) {
        lEl.classList.add('active-marker-linked');
      }
    });
  }
}

function initMarkerMode() {
  const btnMarker = document.getElementById('btnMarkerToggle');
  if (btnMarker) {
    btnMarker.classList.add('on');
    btnMarker.addEventListener('click', toggleMarkerMode);
  }

  const hikeCodeEl = document.getElementById('hikeCode');
  if (hikeCodeEl) {
    hikeCodeEl.addEventListener('click', () => {
      if (!isMarkerModeActive || isDebugging) return;
      const lineNum = hikeCodeEl.value.substr(0, hikeCodeEl.selectionStart).split('\n').length;
      updateMarkerHighlightsFromHikeLine(lineNum);
    });
    hikeCodeEl.addEventListener('keyup', () => {
      if (!isMarkerModeActive || isDebugging) return;
      const lineNum = hikeCodeEl.value.substr(0, hikeCodeEl.selectionStart).split('\n').length;
      updateMarkerHighlightsFromHikeLine(lineNum);
    });
  }

  const llvmEl = document.getElementById('llvmCode');
  if (llvmEl) {
    llvmEl.addEventListener('click', (e) => {
      if (!isMarkerModeActive || isDebugging) return;
      const lineEl = e.target.closest('.code-line');
      if (lineEl) updateMarkerHighlightsFromLlvmLine(lineEl);
    });
  }

  const wasmEl = document.getElementById('wasmCode');
  if (wasmEl) {
    wasmEl.addEventListener('click', (e) => {
      if (!isMarkerModeActive || isDebugging) return;
      const lineEl = e.target.closest('.code-line');
      if (lineEl) updateMarkerHighlightsFromWasmLine(lineEl);
    });
  }
}



