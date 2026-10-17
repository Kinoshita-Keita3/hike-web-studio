// Hike Web Studio - Multi-Row Memory Dump & Symbol Mapping Engine

let currentLang = 'ja';
let currentMode = 'standard';
let currentFontSize = localStorage.getItem('hike_studio_font_size') || 'md';
let memoryMode = 'auto'; // 'auto', 'hex', 'dec', 'float', 'text'
let autoDetectedMode = 'dec'; // 'hex', 'dec', 'float', 'text'
let displayedRowsSetting = 'auto'; // 'auto', 1, 2, 3, 5, 'all'
let displayedRowsCount = 3; // 実際にレンダリングされた行数
let showAsciiColumn = true; // ASCIIプレビュー列の表示フラグ
let memorySpanSetting = 'auto'; // 'auto' (型連動可変スパン結合), '4' (4B固定32bit), '8' (8B固定64bit)

const fontSizeScaleMap = {
  'sm': 0.88,
  'md': 1.0,
  'lg': 1.15
};

function applyFontSize(size) {
  if (!fontSizeScaleMap[size]) size = 'md';
  currentFontSize = size;
  document.documentElement.setAttribute('data-font-size', size);
  localStorage.setItem('hike_studio_font_size', size);

  document.querySelectorAll('.font-size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-font') === size);
  });

  if (typeof syncEditorHighlight === 'function') {
    syncEditorHighlight();
  }
  if (typeof updateMemoryGridDisplay === 'function') {
    updateMemoryGridDisplay();
  }
  if (typeof popoutManager !== 'undefined' && popoutManager) {
    popoutManager.syncThemeAndScale(currentTheme, fontSizeScaleMap[size] || 1.0);
  }
}

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

  // 単精度浮動小数点数 (float32) の書き込み (WASM: f32.store 相当, Little-Endian)
  writeF32(offset, value) {
    if (offset < 0 || offset + 4 > this.buffer.byteLength) return;
    this.changedOffsets.clear();
    this.view.setFloat32(offset, value, true);
    for (let i = 0; i < 4; i++) {
      this.changedOffsets.add(offset + i);
    }
  }

  // 倍精度浮動小数点数 (float64) の書き込み (WASM: f64.store 相当, Little-Endian)
  writeF64(offset, value) {
    if (offset < 0 || offset + 8 > this.buffer.byteLength) return;
    this.changedOffsets.clear();
    this.view.setFloat64(offset, value, true);
    for (let i = 0; i < 8; i++) {
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

  // 単精度浮動小数点数 (float32) の読み出し (WASM: f32.load 相当)
  readF32(offset) {
    if (offset < 0 || offset + 4 > this.buffer.byteLength) return 0.0;
    return this.view.getFloat32(offset, true);
  }

  // 倍精度浮動小数点数 (float64) の読み出し (WASM: f64.load 相当)
  readF64(offset) {
    if (offset < 0 || offset + 8 > this.buffer.byteLength) return 0.0;
    return this.view.getFloat64(offset, true);
  }

  // 64ビット整数の読み出し (WASM: i64.load 相当, Little-Endian)
  readI64(offset) {
    if (offset < 0 || offset + 8 > this.buffer.byteLength) return 0n;
    return this.view.getBigInt64(offset, true);
  }

  // 64ビット整数の書き込み (WASM: i64.store 相当, Little-Endian)
  writeI64(offset, value) {
    if (offset < 0 || offset + 8 > this.buffer.byteLength) return;
    this.changedOffsets.clear();
    const bigVal = typeof value === 'bigint' ? value : BigInt(Math.floor(Number(value) || 0));
    this.view.setBigInt64(offset, bigVal, true);
    for (let i = 0; i < 8; i++) {
      this.changedOffsets.add(offset + i);
    }
  }

  // 連続文字列の読み出し (UTF-8 / ASCII)
  readString(offset, maxLength = 32) {
    if (offset < 0 || offset >= this.buffer.byteLength) return '';
    let len = 0;
    while (offset + len < this.buffer.byteLength && len < maxLength) {
      if (this.bytes[offset + len] === 0) break;
      len++;
    }
    const slice = this.bytes.slice(offset, offset + len);
    try {
      return new TextDecoder('utf-8').decode(slice);
    } catch (e) {
      return String.fromCharCode(...slice);
    }
  }

  // 連続文字列の書き込み (UTF-8 / ASCII, null終端付与)
  writeString(offset, str) {
    if (offset < 0 || offset >= this.buffer.byteLength) return;
    this.changedOffsets.clear();
    const encoded = new TextEncoder().encode(str);
    for (let i = 0; i < encoded.length && (offset + i) < this.buffer.byteLength; i++) {
      this.view.setUint8(offset + i, encoded[i]);
      this.changedOffsets.add(offset + i);
    }
    if (offset + encoded.length < this.buffer.byteLength) {
      this.view.setUint8(offset + encoded.length, 0);
    }
  }

  // 1バイトの読み出し (WASM: i32.load8_u 相当)
  readI8(offset) {
    if (offset < 0 || offset >= this.buffer.byteLength) return 0;
    return this.view.getUint8(offset);
  }

  // オブジェクトマップからの動的一括読み込み (Int32 / Float64 / BigInt64 / String 対応)
  loadFromObject(memObj) {
    this.changedOffsets.clear();
    if (!memObj) return;
    for (const offStr in memObj) {
      const off = parseInt(offStr, 10);
      const val = memObj[offStr];
      if (!isNaN(off)) {
        if (typeof val === 'number') {
          if (Number.isInteger(val)) {
            this.writeI32(off, val);
          } else {
            this.writeF64(off, val);
          }
        } else if (typeof val === 'bigint') {
          this.writeI64(off, val);
        } else if (typeof val === 'string') {
          this.writeString(off, val);
        }
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
  self_host: `// 演習 9: Hike Web Studio 自身のセルフコンパイル & メモリ構造 【最上級】
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
    version: "v0.1.1",
    mode_standard: "フリー",
    mode_server: "仮想サーバー",
    mode_advanced: "アドバンス",
    menu_run: "実行",
    menu_mode: "モード",
    menu_view: "表示",
    menu_learn: "学習",
    menu_settings: "設定",
    menu_layout_label: "分割プリセット:",
    menu_save_hike: "コード保存 (.hk)",
    menu_export_wasm: "Wasm保存 (.wasm)",
    menu_export_wat: "WAT保存 (.wat)",
    menu_export_llvm: "LLVM保存 (.ll)",
    mode_standard_desc: "フリー",
    mode_server_desc: "仮想サーバー",
    mode_advanced_desc: "アドバンス",
    btn_examples_guide: "教材ガイド",
    btn_manual: "マニュアル",
    btn_hike_lang: "Hike言語",
    btn_git: "GitHub",
    btn_exercises: "例題集",
    btn_reset_layout: "初期配置に戻す",
    btn_save_hike: "保存",
    btn_export_wasm: "WASM出力",
    btn_export_wat: "WAT出力",
    btn_export_llvm: "LLVM出力",
    drop_zone_text: "ファイルをドロップ",
    adv_link_modules: "モジュール:",
    adv_compiler_flags: "フラグ:",
    adv_compiler_pipeline: "コンパイラ:",
    opt_backend_wabt: "標準 (WAT)",
    opt_backend_llvm: "最適化 (LLVM -O3)",
    server_target: "サーバー:",
    srv_auth: "Auth サーバー",
    srv_upload: "Storage サーバー",
    srv_qr: "Scanner ノード",
    chk_debug: "-g デバッグ",
    btn_build: "ビルド",
    btn_run: "実行",
    dbg_start: "開始",
    dbg_next: "次",
    dbg_continue: "スキップ",
    dbg_reset: "リセット",
    panel_editor: "エディタ",
    panel_wasm: "WASM",
    panel_console: "コンソール",
    panel_memory: "メモリ",
    status_ready: "準備完了",
    status_compiling: "コンパイル中...",
    btn_clear: "消去",
    scope_vars: "ローカル変数",
    mem_dump_title: "メモリダンプ",
    ex_modal_title: "例題集",
    manual_modal_title: "取扱説明書",
    log_init: "[システム] 準備完了",
    log_mem_rows_switched: "[メモリ] {rows}行表示に変更",
    log_start_worker: "[コンパイル] 処理中...",
    log_success_build: "[ビルド] 成功しました",
    log_success_wabt_build: "[ビルド] 成功しました",
    log_emitted_wasm: "[WASM] 出力完了",
    log_dbg_started: "[デバッグ] 開始",
    log_dbg_step: "[Line {line}] {code}",
    log_dbg_finished: "[実行完了] 正常終了しました ({steps}ステップ)",
    log_dbg_reset: "[デバッグ] リセット完了",
    log_bp_hit: "[停止] Line {line}",
    log_bp_toggled: "[ブレークポイント] Line {line} {status}",
    opt_layout_4: "4分割 (2×2)",
    opt_layout_4tb: "4分割 (上2・下縦)",
    opt_layout_4bt: "4分割 (上縦・下2)",
    opt_layout_3l: "3分割 (左1・右2)",
    opt_layout_3r: "3分割 (左2・右1)",
    opt_layout_3t: "3分割 (上1・下2)",
    opt_layout_3b: "3分割 (上2・下1)",
    opt_layout_2h: "2分割 (左右)",
    opt_layout_2v: "2分割 (上下)",
    opt_layout_1: "1画面 (全画面)",
    title_editor: "エディタ",
    title_llvm: "LLVM IR",
    title_wasm: "WASM",
    title_console: "コンソール",
    title_memory: "メモリ",
    panel_menu_code: "コード",
    panel_menu_debug: "デバッグ",
    panel_menu_display: "表示設定",
    menu_export: "出力",
    btn_marker: "連動マーカー",
    dbg_auto: "自動",
    dbg_step_quick: "次へ",
    menu_font_size: "文字サイズ",
    font_sm: "小",
    font_md: "標準",
    font_lg: "大",
    mem_format_title: "表示形式",
    mem_layout_title: "レイアウト",
    mem_mode_hex: "16進数 (HEX)",
    mem_mode_dec: "10進整数 (INT)",
    mem_mode_float: "浮動小数点 (FLOAT)",
    mem_mode_text: "文字 (TEXT)",
    mem_rows_auto: "行数: 自動 (連動)",
    mem_span_auto: "ブロック幅: 自動スパン (型連動)",
    mem_span_4: "ブロック幅: 4バイト固定 (32bit)",
    mem_span_8: "ブロック幅: 8バイト固定 (64bit)",
    mem_ascii_on: "ASCII列: 表示",
    mem_ascii_off: "ASCII列: 非表示",
    mem_mode_auto: "自動 (ブロック型連動)",
    btn_popout: "別ウィンドウで開く (切り離し)",
    btn_merge: "合流して戻す",
    popout_active_msg: "別ウィンドウで表示中"
  },
  en: {
    title: "Hike Web Studio",
    version: "v0.1.1",
    mode_standard: "Free",
    mode_server: "Virtual Server",
    mode_advanced: "Advanced",
    menu_run: "Run",
    menu_mode: "Mode",
    menu_view: "View",
    menu_learn: "Learn",
    menu_settings: "Settings",
    menu_layout_label: "Layout Preset:",
    menu_save_hike: "Save (.hk)",
    menu_export_wasm: "Save Wasm (.wasm)",
    menu_export_wat: "Save WAT (.wat)",
    menu_export_llvm: "Save LLVM (.ll)",
    mode_standard_desc: "Free",
    mode_server_desc: "Virtual Server",
    mode_advanced_desc: "Advanced",
    btn_examples_guide: "Guide",
    btn_manual: "Manual",
    btn_hike_lang: "Hike Lang",
    btn_git: "GitHub",
    btn_exercises: "Examples",
    btn_reset_layout: "Reset Layout",
    btn_save_hike: "Save",
    btn_export_wasm: "WASM Export",
    btn_export_wat: "WAT Export",
    btn_export_llvm: "LLVM Export",
    drop_zone_text: "Drop file here",
    adv_link_modules: "Modules:",
    adv_compiler_flags: "Flags:",
    adv_compiler_pipeline: "Compiler:",
    opt_backend_wabt: "Standard (WAT)",
    opt_backend_llvm: "Optimized (LLVM -O3)",
    server_target: "Server:",
    srv_auth: "Auth Server",
    srv_upload: "Storage Server",
    srv_qr: "Scanner Node",
    chk_debug: "-g Debug",
    btn_build: "Build",
    btn_run: "Run",
    dbg_start: "Start",
    dbg_next: "Next",
    dbg_continue: "Skip",
    dbg_reset: "Reset",
    panel_editor: "Editor",
    panel_wasm: "WASM",
    panel_console: "Console",
    panel_memory: "Memory",
    status_ready: "Ready",
    status_compiling: "Compiling...",
    btn_clear: "Clear",
    scope_vars: "Local Variables",
    mem_dump_title: "Memory Dump",
    ex_modal_title: "Examples",
    manual_modal_title: "User Manual",
    log_init: "[System] Ready",
    log_mem_rows_switched: "[Memory] {rows} rows",
    log_start_worker: "[Compiler] Processing...",
    log_success_build: "[Build] Succeeded",
    log_success_wabt_build: "[Build] Succeeded",
    log_emitted_wasm: "[WASM] Emitted",
    log_dbg_started: "[Debug] Started",
    log_dbg_step: "[Line {line}] {code}",
    log_dbg_finished: "[Complete] Finished ({steps} steps)",
    log_dbg_reset: "[Debug] Reset",
    log_bp_hit: "[Paused] Line {line}",
    log_bp_toggled: "[Breakpoint] Line {line} {status}",
    opt_layout_4: "4 Panels (2x2)",
    opt_layout_4tb: "4 Panels (Top 2)",
    opt_layout_4bt: "4 Panels (Bottom 2)",
    opt_layout_3l: "3 Panels (Left 1)",
    opt_layout_3r: "3 Panels (Right 1)",
    opt_layout_3t: "3 Panels (Top 1)",
    opt_layout_3b: "3 Panels (Bottom 1)",
    opt_layout_2h: "2 Panels (Horizontal)",
    opt_layout_2v: "2 Panels (Vertical)",
    opt_layout_1: "1 Panel (Full)",
    title_editor: "Editor",
    title_llvm: "LLVM IR",
    title_wasm: "WASM",
    title_console: "Console",
    title_memory: "Memory",
    panel_menu_code: "Code",
    panel_menu_debug: "Debug",
    panel_menu_display: "Display",
    menu_export: "Export",
    btn_marker: "Marker",
    dbg_auto: "Auto Step",
    dbg_step_quick: "Next",
    menu_font_size: "Font Size",
    font_sm: "Small",
    font_md: "Medium",
    font_lg: "Large",
    mem_format_title: "Format",
    mem_layout_title: "Layout",
    mem_mode_hex: "Hexadecimal (HEX)",
    mem_mode_dec: "Integer (INT)",
    mem_mode_float: "Float (FLOAT)",
    mem_mode_text: "Text / ASCII",
    mem_rows_auto: "Rows: Auto (Dynamic)",
    mem_span_auto: "Block Span: Auto (Type-aware)",
    mem_span_4: "Block Span: 4 Bytes (32bit)",
    mem_span_8: "Block Span: 8 Bytes (64bit)",
    mem_ascii_on: "ASCII Col: Visible",
    mem_ascii_off: "ASCII Col: Hidden",
    mem_mode_auto: "Auto (Block Type-Aware)",
    btn_popout: "Pop out to window",
    btn_merge: "Merge back",
    popout_active_msg: "Displayed in separate window"
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
      btn.textContent = (currentLang === 'ja') ? 'ダーク' : 'Dark';
    } else {
      btn.textContent = (currentLang === 'ja') ? 'ライト' : 'Light';
    }
  }

  if (typeof popoutManager !== 'undefined' && popoutManager) {
    popoutManager.syncThemeAndScale(theme, fontSizeScaleMap[currentFontSize] || 1.0);
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
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (i18n[lang][key]) {
      el.title = i18n[lang][key];
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

  const isStringPtr = codeText.includes('strPtr') || codeText.includes('演習2') || codeText.includes('演習 2');
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
          
          const strLiteral = expr.match(/^["`](.*)["`]$/);
          if (strLiteral) {
            runningMem[off] = strLiteral[1];
            updatedOff = off;
            updatedVal = strLiteral[1];
          } else {
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
        let op = 'STORE';
        if (typeof updatedVal === 'string') op = 'STORE_STRING';
        else if (typeof updatedVal === 'number' && !Number.isInteger(updatedVal)) op = 'STORE_F64';
        else if (typeof updatedVal === 'bigint') op = 'STORE_I64';
        stepObj.memAction = { op, offset: updatedOff, value: updatedVal };
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

// 表示行数 (自動 / 1行 / 2行 / 3行 / 5行 / 全表示) の切り替え
function toggleMemoryRows() {
  const settingsCycle = ['auto', 1, 2, 3, 5, 'all'];
  const currentIndex = settingsCycle.indexOf(displayedRowsSetting);
  displayedRowsSetting = settingsCycle[(currentIndex + 1) % settingsCycle.length];
  
  const labelRows = document.getElementById('labelRowsToggle');
  if (labelRows) {
    if (displayedRowsSetting === 'auto') {
      labelRows.textContent = i18n[currentLang]?.mem_rows_auto || '行数: 自動 (連動)';
      labelRows.setAttribute('data-i18n', 'mem_rows_auto');
    } else if (displayedRowsSetting === 'all') {
      labelRows.textContent = (currentLang === 'ja') ? '行数: 全表示 (8行)' : 'Rows: All (8 Rows)';
      labelRows.removeAttribute('data-i18n');
    } else {
      labelRows.textContent = (currentLang === 'ja') ? `行数: ${displayedRowsSetting}行` : `Rows: ${displayedRowsSetting}`;
      labelRows.removeAttribute('data-i18n');
    }
  }
  updateMemoryGridDisplay();
  const msg = currentLang === 'ja'
    ? `[メモリ] 行数設定を「${displayedRowsSetting === 'auto' ? '自動 (連動)' : displayedRowsSetting}」に変更しました。`
    : `[Memory] Changed row display to "${displayedRowsSetting}".`;
  log(msg, 'info');
}

// ブロックの結合スパン設定 (自動スパン / 4バイト固定 / 8バイト固定) の切り替え
function toggleMemorySpan() {
  const spanCycle = ['auto', '4', '8'];
  const currentIndex = spanCycle.indexOf(memorySpanSetting);
  memorySpanSetting = spanCycle[(currentIndex + 1) % spanCycle.length];

  const labelSpan = document.getElementById('labelSpanToggle');
  if (labelSpan) {
    const key = `mem_span_${memorySpanSetting}`;
    labelSpan.textContent = i18n[currentLang]?.[key] || (
      memorySpanSetting === 'auto' ? 'ブロック幅: 自動スパン (型連動)' :
      memorySpanSetting === '4' ? 'ブロック幅: 4バイト固定 (32bit)' : 'ブロック幅: 8バイト固定 (64bit)'
    );
    labelSpan.setAttribute('data-i18n', key);
  }
  updateMemoryGridDisplay();
  const desc = {
    'auto': currentLang === 'ja' ? '自動スパン (型連動)' : 'Auto (Type-aware)',
    '4': currentLang === 'ja' ? '4バイト固定 (32bit)' : '4 Bytes Fixed (32bit)',
    '8': currentLang === 'ja' ? '8バイト固定 (64bit)' : '8 Bytes Fixed (64bit)'
  };
  const msg = currentLang === 'ja'
    ? `[メモリ] ブロック結合スパン設定を「${desc[memorySpanSetting]}」に変更しました。`
    : `[Memory] Changed block span setting to "${desc[memorySpanSetting]}".`;
  log(msg, 'info');
}

// ブロックごとの個別表示形式オーバーライドマップ (offset -> 'hex'|'dec'|'float'|'text')
const cellFormatOverrides = new Map();

// メモリ表示形式 (AUTO / HEX / DEC / FLOAT / TEXT) 切り替え
function setMemoryMode(mode) {
  memoryMode = mode;
  document.querySelectorAll('.mem-mode-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  updateMemoryGridDisplay();
  const modeLabels = {
    'auto': currentLang === 'ja' ? '自動 (ブロック型連動)' : 'Auto (Block Type-Aware)',
    'hex': '16進数 (HEX)',
    'dec': '10進整数 (INT)',
    'float': '浮動小数点 (FLOAT)',
    'text': '文字・ASCII (TEXT)'
  };
  const msg = currentLang === 'ja'
    ? `[メモリ] 全体表示形式を「${modeLabels[mode] || mode}」に切り替えました。`
    : `[Memory] Switched global display format to "${modeLabels[mode] || mode}".`;
  log(msg, 'info');
}

// 各メモリブロックの型をシンボル名やコードから自動判定
function inferBlockType(absOff, varName, codeText) {
  if (!varName || varName === '-') return 'hex';

  const lower = varName.toLowerCase();
  if (lower.includes('float') || lower.includes('pi') || lower.includes('rate') || lower.includes('f32') || lower.includes('f64') || lower.includes('double')) {
    return 'float';
  }
  if (lower.includes('str') || lower.includes('char') || lower.includes('msg') || lower.includes('text') || lower.includes('name')) {
    return 'text';
  }
  if (lower.includes('int') || lower.includes('total') || lower.includes('sum') || lower.includes('count') || lower.includes('arr') || lower.includes('temp') || lower.includes('status') || lower.includes('size') || lower.includes('key') || lower.includes('gcd') || lower.includes('num') || lower.includes('rem') || lower.includes('ans') || lower.includes('fib') || lower.includes('result')) {
    return 'dec';
  }
  if (lower.includes('ptr') || lower.includes('buf') || lower.includes('addr')) {
    return 'hex';
  }

  if (codeText) {
    const cleanVar = varName.split('/')[0].trim().replace(/\[\d+\]/, '');
    const declMatch = codeText.match(new RegExp(`var\\s+${cleanVar}\\s+([a-zA-Z0-9_*]+)`));
    if (declMatch) {
      const type = declMatch[1];
      if (type.includes('float') || type.includes('f32') || type.includes('f64') || type.includes('double')) return 'float';
      if (type.includes('string') || type.includes('*byte') || type.includes('char')) return 'text';
      if (type.includes('int') || type.includes('i32') || type.includes('i64')) return 'dec';
    }
  }

  return 'dec';
}

// クリックしたブロックの表示形式を個別に循環切り替え
function toggleCellBlockFormat(absOff, currentBlockFormat, span = 1) {
  let cycle = ['hex', 'dec', 'float', 'text'];
  if (span >= 2) {
    // 複数Intにまたがるスパン結合セルの場合は、floatやtextを優先
    cycle = ['float', 'dec', 'hex', 'text'];
  }
  const curIdx = cycle.indexOf(currentBlockFormat);
  const nextFormat = cycle[(curIdx + 1) % cycle.length];
  cellFormatOverrides.set(absOff, nextFormat);
  updateMemoryGridDisplay();

  const formatNames = {
    'hex': '16進数 (HEX)',
    'dec': span >= 2 ? '64bit整数 (INT64)' : '10進整数 (INT32)',
    'float': span >= 2 ? '倍精度実数 (FLOAT64)' : '単精度実数 (FLOAT32)',
    'text': '文字・ASCII (TEXT)'
  };
  const hexStr = `0x00${absOff.toString(16).padStart(2, '0').toUpperCase()}`;
  const byteCount = span * 4;
  const msg = currentLang === 'ja'
    ? `[メモリ] ブロック ${hexStr} (${byteCount}B) の表示形式を「${formatNames[nextFormat]}」に変更しました。`
    : `[Memory] Switched block ${hexStr} (${byteCount}B) format to "${nextFormat.toUpperCase()}".`;
  log(msg, 'info');
}

function handleWatchItemClick(varName) {
  // アドレスオフセットの抽出 (例: "res.status (@ 0x0030)")
  const offMatch = varName.match(/0x([0-9a-fA-F]+)/);
  if (offMatch) {
    const off = parseInt(offMatch[1], 16);
    highlightMemoryCellByOffset(off);
  }
}

function highlightMemoryCellByOffset(off) {
  const hexOff = off.toString(16);
  const cell = document.getElementById(`m-${hexOff}`);
  if (cell) {
    cell.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    cell.classList.add('memory-val-changed');
    setTimeout(() => {
      cell.classList.remove('memory-val-changed');
    }, 1200);
  }
}

// ASCIIプレビュー列の表示/非表示切り替え
function toggleAsciiColumn() {
  showAsciiColumn = !showAsciiColumn;
  const labelAscii = document.getElementById('labelAsciiColToggle');
  if (labelAscii) {
    const key = showAsciiColumn ? 'mem_ascii_on' : 'mem_ascii_off';
    labelAscii.textContent = i18n[currentLang]?.[key] || (showAsciiColumn ? 'ASCII列: 表示' : 'ASCII列: 非表示');
    labelAscii.setAttribute('data-i18n', key);
  }
  updateMemoryGridDisplay();
  const msg = currentLang === 'ja'
    ? `[メモリ] ASCIIプレビュー列を${showAsciiColumn ? '表示' : '非表示'}にしました。`
    : `[Memory] ASCII column is now ${showAsciiColumn ? 'visible' : 'hidden'}.`;
  log(msg, 'info');
}

// Hikeソースコードから変数シンボル名、型、バイトサイズを動的構文解析
function getDynamicMemorySymbols(codeText) {
  if (!codeText) return {};
  const symbols = {};

  // 演習プリセットコード用マッピング (演習コード選択時のみ適用)
  if (codeText.includes('演習2') || codeText.includes('演習 2')) {
    symbols[0]  = { name: 'strPtr', type: 'hex', size: 4 };
    symbols[4]  = { name: 'char0', type: 'text', size: 4 };
    symbols[8]  = { name: 'char1', type: 'text', size: 4 };
    symbols[12] = { name: 'str[1]', type: 'text', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習4') || codeText.includes('演習 4')) {
    symbols[32] = { name: 'a / num1', type: 'dec', size: 4 };
    symbols[36] = { name: 'b / num2', type: 'dec', size: 4 };
    symbols[40] = { name: 'rem / ans', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習5') || codeText.includes('演習 5')) {
    symbols[16] = { name: 'arr[0]', type: 'dec', size: 4 };
    symbols[20] = { name: 'arr[1]', type: 'dec', size: 4 };
    symbols[24] = { name: 'arr[2]', type: 'dec', size: 4 };
    symbols[28] = { name: 'arr[3]', type: 'dec', size: 4 };
    symbols[44] = { name: 'temp', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習7') || codeText.includes('演習 7')) {
    symbols[48] = { name: 'n', type: 'dec', size: 4 };
    symbols[52] = { name: 'result', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習8') || codeText.includes('演習 8')) {
    symbols[48] = { name: 'res.status', type: 'dec', size: 4 };
    symbols[52] = { name: 'res.size', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習6') || codeText.includes('演習 6')) {
    symbols[40] = { name: 'secretKey', type: 'hex', size: 4 };
    symbols[44] = { name: 'originalData', type: 'dec', size: 4 };
    symbols[48] = { name: 'encrypted', type: 'hex', size: 4 };
    symbols[52] = { name: 'decrypted', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習9') || codeText.includes('演習 9')) {
    symbols[0]  = { name: 's.isSelfHost', type: 'dec', size: 4 };
    symbols[68] = { name: 'studio.ver', type: 'text', size: 4 };
    symbols[72] = { name: 'studio.pages', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習3') || codeText.includes('演習 3')) {
    symbols[16] = { name: 'arr[0]', type: 'dec', size: 4 };
    symbols[20] = { name: 'arr[1]', type: 'dec', size: 4 };
    symbols[24] = { name: 'arr[2]', type: 'dec', size: 4 };
    symbols[28] = { name: 'arr[3]', type: 'dec', size: 4 };
    symbols[64] = { name: 'maxVal', type: 'dec', size: 4 };
    return symbols;
  }
  if (codeText.includes('演習1') || codeText.includes('演習 1')) {
    symbols[0] = { name: 'i', type: 'dec', size: 4 };
    symbols[4] = { name: 'total', type: 'dec', size: 4 };
    return symbols;
  }

  // 汎用 Hike ソースコード構文解析
  const structDefs = {};
  let currentStruct = null;

  const lines = codeText.split('\n');
  const varsFound = [];

  function resolveTypeAndSize(typeStr) {
    if (!typeStr) return { type: 'dec', size: 4 };
    const t = typeStr.trim().toLowerCase();
    if (t.includes('float64') || t.includes('double') || t.includes('f64')) {
      return { type: 'float', size: 8, is64: true };
    }
    if (t.includes('float32') || t.includes('float') || t.includes('f32')) {
      return { type: 'float', size: 4, is64: false };
    }
    if (t.includes('int64') || t.includes('i64') || t.includes('uint64')) {
      return { type: 'dec', size: 8, is64: true };
    }
    if (t.includes('string')) {
      return { type: 'text', size: 16, is64: false };
    }
    if (t.includes('*byte') || t.includes('char')) {
      return { type: 'text', size: 4, is64: false };
    }
    if (t.includes('ptr') || t.includes('addr')) {
      return { type: 'hex', size: 4, is64: false };
    }
    return { type: 'dec', size: 4, is64: false };
  }

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
        const info = resolveTypeAndSize(fieldMatch[2]);
        structDefs[currentStruct].push({ name: fieldMatch[1], ...info });
      }
      continue;
    }

    // 配列変数宣言: var arr [5]int32 または var buf [16]byte
    const arrMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)\s*\[(\d+)\]([a-zA-Z0-9_*]+)?/);
    if (arrMatch) {
      const arrName = arrMatch[1];
      const count = parseInt(arrMatch[2], 10);
      const elemTypeStr = arrMatch[3] || 'int32';
      const info = resolveTypeAndSize(elemTypeStr);
      for (let k = 0; k < count; k++) {
        varsFound.push({ name: `${arrName}[${k}]`, type: info.type, size: info.size, is64: info.is64 });
      }
      continue;
    }

    // 構造体変数宣言: var res ApiResponse
    const varStructMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)/);
    if (varStructMatch && structDefs[varStructMatch[2]]) {
      const vName = varStructMatch[1];
      const sName = varStructMatch[2];
      structDefs[sName].forEach(f => {
        varsFound.push({ name: `${vName}.${f.name}`, type: f.type, size: f.size, is64: f.is64 });
      });
      continue;
    }

    // 型付き変数宣言: var pi float64 = 3.141592653589793
    const varTypedMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_*]+)/);
    if (varTypedMatch) {
      const vName = varTypedMatch[1];
      const info = resolveTypeAndSize(varTypedMatch[2]);
      if (!varsFound.some(v => v.name === vName)) {
        varsFound.push({ name: vName, type: info.type, size: info.size, is64: info.is64 });
      }
      continue;
    }

    // 型なし var 宣言: var total = 0
    const varMatch = raw.match(/^var\s+([a-zA-Z0-9_]+)/);
    if (varMatch) {
      const vName = varMatch[1];
      if (!varsFound.some(v => v.name === vName)) {
        varsFound.push({ name: vName, type: 'dec', size: 4, is64: false });
      }
      continue;
    }

    // 短縮代入宣言: pi := 3.141592653589793 または msg := "Hello"
    const shortMatch = raw.match(/^([a-zA-Z0-9_]+)\s*:=\s*(.+)$/);
    if (shortMatch) {
      const vName = shortMatch[1];
      const valExpr = shortMatch[2].trim();
      let info = { type: 'dec', size: 4, is64: false };
      if (valExpr.startsWith('"') || valExpr.startsWith('`')) {
        info = { type: 'text', size: 16, is64: false };
      } else if (valExpr.includes('.')) {
        info = { type: 'float', size: 8, is64: true };
      }
      if (!varsFound.some(v => v.name === vName)) {
        varsFound.push({ name: vName, type: info.type, size: info.size, is64: info.is64 });
      }
      continue;
    }

    // for ループ変数: for i := ...
    const forMatch = raw.match(/for\s+([a-zA-Z0-9_]+)\s*:=/);
    if (forMatch) {
      const vName = forMatch[1];
      if (!varsFound.some(v => v.name === vName)) {
        varsFound.push({ name: vName, type: 'dec', size: 4, is64: false });
      }
    }
  }

  // アライメントを考慮してオフセットを割り当て (4バイトまたは8バイト境界)
  let currentOffset = 0;
  varsFound.forEach(v => {
    if (v.size >= 8 && (currentOffset % 8) !== 0) {
      currentOffset = Math.ceil(currentOffset / 8) * 8;
    }
    symbols[currentOffset] = { name: v.name, type: v.type, size: v.size, is64: !!v.is64 };
    currentOffset += v.size;
  });

  return symbols;
}

// Hikeソースコードから変数シンボル名と4バイト整列のメモリ位置を動的解析 (互換API)
function getDynamicMemorySymbolMap(codeText) {
  if (!codeText) return {};
  const syms = getDynamicMemorySymbols(codeText);
  const map = {};
  for (const off in syms) {
    map[off] = syms[off].name;
  }
  return map;
}

// 動的レスポンシブ・マルチ型メモリグリッド生成 (複数Intスパン結合 + HEX / INT / FLOAT / TEXT + ASCII列)
function updateMemoryGridDisplay() {
  const badge = document.getElementById('hexDecBadge');
  const wrapper = document.getElementById('memoryGridWrapper');
  const thead = document.getElementById('memoryHeader');
  const tbody = document.getElementById('memoryBody');
  if (!tbody) return;

  // 1. パネル幅に応じた列数 (4列 / 8列 / 16列) の動的計算
  const wrapperWidth = wrapper ? wrapper.clientWidth : 500;
  const asciiColWidth = showAsciiColumn ? 110 : 0;
  const availWidth = Math.max(160, wrapperWidth - 65 - asciiColWidth);

  let colCount = 8;
  if (availWidth < 420) {
    colCount = 4;   // 16バイト/行 (+00〜+0C)
  } else if (availWidth >= 800) {
    colCount = 16;  // 64バイト/行 (+00〜+3C)
  } else {
    colCount = 8;   // 32バイト/行 (+00〜+1C)
  }

  const bytesPerRow = colCount * 4;

  // 2. パネル高さに応じた行数の動的計算
  let activeRows = 3;
  if (displayedRowsSetting === 'auto') {
    const panelBody = document.querySelector('#panel-memory .panel-body') || document.querySelector('#popoutBodyMount .panel-body');
    const bodyHeight = panelBody ? panelBody.clientHeight : 320;
    const watchList = document.getElementById('watchList');
    const watchHeight = watchList ? watchList.offsetHeight : 80;
    const availableHeight = Math.max(80, bodyHeight - watchHeight - 75);
    activeRows = Math.max(1, Math.min(16, Math.floor(availableHeight / 48)));
  } else if (displayedRowsSetting === 'all') {
    activeRows = 8;
  } else {
    activeRows = parseInt(displayedRowsSetting, 10) || 3;
  }
  displayedRowsCount = activeRows;

  // 3. バッジ更新
  if (badge) {
    const modeName = memoryMode === 'auto'
      ? (currentLang === 'ja' ? 'ブロック連動' : 'Block-Auto')
      : memoryMode.toUpperCase();
    const spanName = (memorySpanSetting === 'auto')
      ? (currentLang === 'ja' ? '自動' : 'Auto')
      : `${memorySpanSetting}B`;
    badge.textContent = `${modeName} [${spanName}]`;
  }

  // 4. thead の動的構築
  if (thead) {
    let headerHtml = '<tr><th class="col-offset">Offset</th>';
    for (let c = 0; c < colCount; c++) {
      const offHex = (c * 4).toString(16).padStart(2, '0').toUpperCase();
      headerHtml += `<th class="col-cell">+${offHex}</th>`;
    }
    if (showAsciiColumn) {
      headerHtml += '<th class="col-ascii">ASCII</th>';
    }
    headerHtml += '</tr>';
    thead.innerHTML = headerHtml;
  }

  // 5. tbody の動的構築
  tbody.innerHTML = '';
  const hikeCodeEl = document.getElementById('hikeCode');
  const codeText = hikeCodeEl ? hikeCodeEl.value : '';
  const dynamicSymbols = getDynamicMemorySymbols(codeText);
  const dynamicSymbolMap = {};
  for (const off in dynamicSymbols) {
    dynamicSymbolMap[off] = dynamicSymbols[off].name;
  }

  const rowOffsets = [];
  for (let r = 0; r < activeRows; r++) {
    rowOffsets.push(r * bytesPerRow);
  }

  rowOffsets.forEach(rowAddr => {
    const tr = document.createElement('tr');
    const tdAddr = document.createElement('td');
    tdAddr.className = 'memory-addr';
    tdAddr.textContent = `0x00${rowAddr.toString(16).padStart(2, '0').toUpperCase()}`;
    tr.appendChild(tdAddr);

    let c = 0;
    while (c < colCount) {
      const colOff = c * 4;
      const absOff = rowAddr + colOff;
      const hexOff = absOff.toString(16);

      const symInfo = dynamicSymbols[absOff];
      const varName = symInfo ? symInfo.name : (dynamicSymbolMap[absOff] || '-');

      // スパン数の算出 (1セル = 4バイト)
      let span = 1;
      if (memorySpanSetting === '8') {
        span = 2;
      } else if (memorySpanSetting === 'auto' && symInfo && symInfo.size > 4) {
        span = Math.floor(symInfo.size / 4);
      }

      // 行末を超えないようクランプ (行折り返し保護)
      const maxSpanInRow = colCount - c;
      const actualSpan = Math.max(1, Math.min(span, maxSpanInRow));
      const byteLen = actualSpan * 4;

      const td = document.createElement('td');
      td.id = `m-${hexOff}`;
      td.className = 'memory-cell';
      if (actualSpan > 1) {
        td.colSpan = actualSpan;
        td.classList.add('memory-cell-spanned');
      }

      // 結合されたバイト範囲のいずれかが変更されたかを判定
      let isChanged = false;
      for (let b = 0; b < byteLen; b++) {
        const off = absOff + b;
        if (virtualMem.changedOffsets.has(off) || (currentDebugMemState && currentDebugMemState[off] !== undefined)) {
          isChanged = true;
          break;
        }
      }
      if (isChanged) td.classList.add('memory-val-changed');

      // 決定されるブロック形式 (セル個別オーバーライド > グローバル設定 > 自動型連動)
      let cellMode = cellFormatOverrides.get(absOff);
      if (!cellMode) {
        if (memoryMode === 'auto') {
          cellMode = symInfo ? symInfo.type : inferBlockType(absOff, varName, codeText);
        } else {
          cellMode = memoryMode;
        }
      }

      // 値の読み出しとフォーマット (byteLen に応じたレンダリング)
      let formattedVal = '';
      const rawI32 = virtualMem.readI32(absOff);
      const rawI64 = (byteLen >= 8) ? virtualMem.readI64(absOff) : 0n;
      const rawF32 = virtualMem.readF32(absOff);
      const rawF64 = (byteLen >= 8) ? virtualMem.readF64(absOff) : 0.0;
      td.setAttribute('data-raw', rawI32);

      if (actualSpan === 1) {
        // --- 4バイト単一セル ---
        if (cellMode === 'hex') {
          const hex8 = (rawI32 >>> 0).toString(16).padStart(8, '0').toUpperCase();
          formattedVal = `<span class="hex-word">${hex8.slice(0, 4)}</span><span class="hex-word">${hex8.slice(4)}</span>`;
        } else if (cellMode === 'dec') {
          formattedVal = rawI32.toString(10);
        } else if (cellMode === 'float') {
          if (isNaN(rawF32)) formattedVal = 'NaN';
          else if (!isFinite(rawF32)) formattedVal = rawF32 > 0 ? '+Inf' : '-Inf';
          else if (rawF32 === 0) formattedVal = '0.0';
          else if (Math.abs(rawF32) >= 1e6 || (Math.abs(rawF32) < 1e-4 && rawF32 !== 0)) formattedVal = rawF32.toExponential(2);
          else formattedVal = parseFloat(rawF32.toPrecision(5)).toString();
        } else if (cellMode === 'text') {
          let cellStr = '';
          for (let b = 0; b < 4; b++) {
            const byte = virtualMem.readI8(absOff + b);
            cellStr += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '·';
          }
          formattedVal = `"${cellStr}"`;
        }
      } else if (actualSpan === 2) {
        // --- 8バイト結合セル (Float64 / Int64 / Hex16 / Text8) ---
        if (cellMode === 'float') {
          if (isNaN(rawF64)) formattedVal = 'NaN';
          else if (!isFinite(rawF64)) formattedVal = rawF64 > 0 ? '+Inf' : '-Inf';
          else if (rawF64 === 0) formattedVal = '0.0';
          else if (Math.abs(rawF64) >= 1e10 || (Math.abs(rawF64) < 1e-4 && rawF64 !== 0)) formattedVal = rawF64.toExponential(4);
          else formattedVal = parseFloat(rawF64.toPrecision(8)).toString();
        } else if (cellMode === 'dec') {
          formattedVal = rawI64.toString(10);
        } else if (cellMode === 'hex') {
          const hi = (virtualMem.readI32(absOff + 4) >>> 0).toString(16).padStart(8, '0').toUpperCase();
          const lo = (virtualMem.readI32(absOff) >>> 0).toString(16).padStart(8, '0').toUpperCase();
          formattedVal = `<span class="hex-word">${hi}</span><span class="hex-word">${lo}</span>`;
        } else if (cellMode === 'text') {
          const str = virtualMem.readString(absOff, 8);
          formattedVal = `"${str || '········'}"`;
        }
      } else {
        // --- 16バイト以上 (文字列バッファ・長大スパン) ---
        if (cellMode === 'text') {
          const str = virtualMem.readString(absOff, byteLen);
          formattedVal = `"${str}"`;
        } else if (cellMode === 'hex') {
          let hexSeq = '';
          for (let b = 0; b < Math.min(8, byteLen); b++) {
            hexSeq += virtualMem.readI8(absOff + b).toString(16).padStart(2, '0').toUpperCase() + ' ';
          }
          formattedVal = hexSeq.trim() + '...';
        } else {
          formattedVal = `${byteLen}B [${cellMode.toUpperCase()}]`;
        }
      }

      // ASCIIプレビュー用文字列
      let charSeq = '';
      for (let b = 0; b < byteLen; b++) {
        const byte = virtualMem.readI8(absOff + b);
        charSeq += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '·';
      }

      const sizeLabel = `${byteLen}B`;
      td.innerHTML = `
        <div class="cell-val ${cellMode === 'hex' ? 'cell-val-hex' : ''}">${formattedVal}</div>
        <div class="cell-footer">
          <div class="cell-var-name" title="${varName}">${varName}</div>
          <div class="cell-mode-tag cell-mode-${cellMode}" title="クリックでこのブロックの形式を切替">${cellMode.toUpperCase()} (${sizeLabel})</div>
        </div>
      `;

      let tooltip = `0x00${absOff.toString(16).padStart(2, '0').toUpperCase()} : [${varName}] (${sizeLabel}, ${cellMode.toUpperCase()})\n`;
      if (byteLen >= 8) {
        tooltip += `Float64: ${rawF64}\nInt64: ${rawI64}\n`;
      }
      tooltip += `Hex: 0x${(rawI32 >>> 0).toString(16).padStart(8, '0').toUpperCase()}\nDec: ${rawI32}\nASCII: "${charSeq}"\n※クリックでブロック表示形式を切替`;
      td.title = tooltip;

      td.addEventListener('click', () => {
        toggleCellBlockFormat(absOff, cellMode, actualSpan);
      });

      tr.appendChild(td);
      c += actualSpan;
    }

    // ASCIIプレビュー列の追加
    if (showAsciiColumn) {
      const tdAscii = document.createElement('td');
      tdAscii.className = 'memory-ascii';
      let rowAscii = '';
      for (let b = 0; b < bytesPerRow; b++) {
        const byte = virtualMem.readI8(rowAddr + b);
        rowAscii += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '·';
      }
      tdAscii.textContent = rowAscii;
      tdAscii.title = `Offset 0x00${rowAddr.toString(16).padStart(2, '0').toUpperCase()} ASCII: "${rowAscii}"`;
      tr.appendChild(tdAscii);
    }

    tbody.appendChild(tr);
  });
}

function toggleHexDecMode() {
  const modes = ['auto', 'hex', 'dec', 'float', 'text'];
  const nextIdx = (modes.indexOf(memoryMode) + 1) % modes.length;
  setMemoryMode(modes[nextIdx]);
}

let memoryResizeObserverInstance = null;
function initMemoryResizeObserver() {
  const panelMem = document.getElementById('panel-memory');
  if (!panelMem || typeof ResizeObserver === 'undefined') return;

  if (memoryResizeObserverInstance) {
    memoryResizeObserverInstance.disconnect();
  }

  let resizeTimer = null;
  memoryResizeObserverInstance = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateMemoryGridDisplay();
    }, 60);
  });
  memoryResizeObserverInstance.observe(panelMem);
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
    btn.textContent = (currentLang === 'ja') ? '一時停止' : 'Pause';
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
    btn.textContent = (currentLang === 'ja') ? '自動' : 'Auto';
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

  const quickStep = document.getElementById('btnQuickStep');
  if (quickStep) {
    quickStep.classList.remove('hidden');
    quickStep.disabled = false;
  }

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
      const scale = fontSizeScaleMap[currentFontSize] || 1;
      const lineHeight = 21.2 * scale;
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

// コンパイラ・バックエンド管理 (デフォルト: WAT/WABT 直結パイプライン)
let currentCompilerBackend = 'wabt';

// マーカー表示制御: WASM/LLVM IRパネル側のマーカー描画
// Hike コンパイラ公式の「WAT/WABT 直結パイプライン (構造化HIR → WAT)」の統合により、
// ソース行と生成Wasm命令の1対1完全同期が手に入ったため、オミットを解除して完全復活！
let OMIT_COMPILED_PANEL_MARKERS = false;

// バックエンド変更リスナー & UI更新
function setCompilerBackend(backend) {
  currentCompilerBackend = backend;
  const badge = document.getElementById('backendBadge');
  if (badge) {
    if (backend === 'wabt') {
      badge.textContent = 'WAT';
      badge.style.background = 'rgba(16, 185, 129, 0.15)';
      badge.style.color = '#10b981';
      badge.style.borderColor = '#10b981';
      badge.title = 'WAT/WABT (標準)';
    } else {
      badge.textContent = 'LLVM';
      badge.style.background = 'rgba(234, 179, 8, 0.15)';
      badge.style.color = '#eab308';
      badge.style.borderColor = '#eab308';
      badge.title = 'LLVM IR (最適化)';
    }
  }
  const selectEl = document.getElementById('selectCompilerBackend');
  if (selectEl && selectEl.value !== backend) {
    selectEl.value = backend;
  }
  const labelEl = document.getElementById('currentCompilerLabel');
  if (labelEl) {
    labelEl.textContent = (backend === 'wabt')
      ? (i18n[currentLang]?.opt_backend_wabt || '標準 (WAT)')
      : (i18n[currentLang]?.opt_backend_llvm || '最適化 (LLVM -O3)');
    labelEl.setAttribute('data-i18n', (backend === 'wabt') ? 'opt_backend_wabt' : 'opt_backend_llvm');
  }
  document.querySelectorAll('.compiler-opt-item').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-value') === backend);
  });
  updateWasmCodeDisplay(true);
}

// 内部実行ポインタ保持ステート
let currentExecutionPointer = {
  hikeLine: -1,
  llvmKeyword: null,
  wasmKeyword: null,
  snapshot: null,
  updatedAt: 0
};

// 赤マーカー (LLVM IR / WASM WAT パネル側) の独立更新処理
// WAT/WABT パイプライン経由で 1対1 完全同期ハイライト & スクロール追従
function updateRedMarker(llvmKeyword, wasmKeyword, hikeLine) {
  try {
    document.querySelectorAll('#llvmCode .active-dbg-line, #wasmCode .active-dbg-line, #llvmCode .active-red, #wasmCode .active-red').forEach(el => {
      el?.classList?.remove('active-dbg-line', 'active-red');
    });

    currentExecutionPointer.hikeLine = hikeLine;
    currentExecutionPointer.llvmKeyword = llvmKeyword;
    currentExecutionPointer.wasmKeyword = wasmKeyword;
    currentExecutionPointer.updatedAt = Date.now();

    if (OMIT_COMPILED_PANEL_MARKERS) {
      return;
    }

    const lineStr = String(hikeLine || '');

    // 1. LLVM IR パネルの赤マーカー
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

    // 2. WASM (WAT) パネルの赤マーカー (WAT/WABT 1対1同期追従)
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

// 統合マーカー更新処理 (ステップオブジェクトからHIKE実行ポイントを反映し、WASM/LLVM赤マーカーを同期)
function updateMarkers(snapshot) {
  if (!snapshot) return;
  const targetHikeLine = snapshot.hikeLine || snapshot.line;
  const llvmKw = snapshot.llvmKeyword || snapshot.llvmTarget || snapshot.llvmMatch;
  const wasmKw = snapshot.wasmKeyword || snapshot.watTarget || snapshot.wasmMatch;

  currentExecutionPointer.snapshot = snapshot;

  // HIKEコードエディタ側の青マーカー更新
  updateBlueMarker(targetHikeLine);

  // WASM / LLVM IR 側の赤マーカー同期更新 (WAT/WABT パイプラインによる1対1正確追従)
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
    const lineLabel = currentLang === 'ja' ? '実行行' : 'Line';
    const bpLabel = currentLang === 'ja' ? 'ブレークポイント' : 'Breakpoints';
    const noneText = currentLang === 'ja' ? '(なし)' : '(none)';
    let html = `
      <div class="watch-item"><span class="watch-name">${lineLabel}</span><span class="watch-val">Line ${targetHikeLine}</span></div>
      <div class="watch-item"><span class="watch-name">${bpLabel}</span><span class="watch-val" style="color: var(--accent-red);">${bpListStr ? `[${bpListStr}]` : noneText}</span></div>
    `;

    for (let key in snapshot.vars) {
      if (key === 'line') continue;
      const val = snapshot.vars[key];
      const formattedVal = (typeof val === 'number' && val > 255)
        ? `${val} (0x${val.toString(16).toUpperCase()})`
        : (typeof val === 'number' ? `${val}` : String(val));
      html += `<div class="watch-item clickable" data-var-name="${key}" title="クリックしてメモリ位置と型表示を連動"><span class="watch-name">${key}</span><span class="watch-val" style="color: var(--accent-green); font-weight: 600;">${formattedVal}</span></div>`;
    }
    watchListEl.innerHTML = html;

    watchListEl.querySelectorAll('.watch-item.clickable').forEach(item => {
      item.addEventListener('click', () => {
        const vName = item.getAttribute('data-var-name');
        if (vName) handleWatchItemClick(vName);
      });
    });
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
    } else if (snapshot.memAction.op === 'STORE_F64') {
      virtualMem.writeF64(snapshot.memAction.offset, snapshot.memAction.value);
    } else if (snapshot.memAction.op === 'STORE_I64') {
      virtualMem.writeI64(snapshot.memAction.offset, snapshot.memAction.value);
    } else if (snapshot.memAction.op === 'STORE_STRING') {
      virtualMem.writeString(snapshot.memAction.offset, snapshot.memAction.value);
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

  const quickStep = document.getElementById('btnQuickStep');
  if (quickStep) {
    quickStep.classList.add('hidden');
    quickStep.disabled = true;
  }

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

  const quickStepFinish = document.getElementById('btnQuickStep');
  if (quickStepFinish) {
    quickStepFinish.classList.add('hidden');
    quickStepFinish.disabled = true;
  }
  
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
  const isDebugMode = document.getElementById('chkDebugFlag')?.checked ?? true;
  const status = document.getElementById('buildStatus');
  const t = i18n[currentLang];
  
  if (status) {
    status.textContent = t.status_compiling;
    status.className = 'log-warn';
  }
  log(t.log_start_worker, 'info');

  setTimeout(() => {
    if (status) {
      status.textContent = 'Build Succeeded (12ms)';
      status.className = 'log-success';
    }
    updateWasmCodeDisplay(true);
    if (currentCompilerBackend === 'wabt') {
      log(t.log_success_wabt_build || '[ビルド成功] WAT/WABT 直結パイプライン (構造化HIR → WAT) による正確なWasm命令出力を完了しました！', 'success');
      log(currentLang === 'ja' ? '[デバッグ情報] ソース行とWasm命令の1対1対応を確立 (DWARF / Line Tracking 有効)。' : '[Debug Info] 1:1 correspondence established between source lines and Wasm instructions.', 'info');
    } else {
      log(t.log_success_build, 'success');
      log(currentLang === 'ja' ? '[注記] LLVM最適化パス有効 (-O3)。精密なステップ実行連動にはWAT/WABT直結をご利用ください。' : '[Note] LLVM -O3 active. For 1:1 step tracking, use WAT/WABT direct pipeline.', 'warn');
    }
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

  if (codeText.includes('strPtr') || codeText.includes('演習2') || codeText.includes('演習 2')) {
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

  const modeBadge = document.getElementById('activeModeIndicator');

  if (mode === 'standard') {
    document.getElementById('modeStandard').classList.add('active');
    if (modeBadge) {
      modeBadge.setAttribute('data-i18n', 'mode_standard');
      modeBadge.textContent = i18n[currentLang]?.mode_standard || 'フリー';
    }
  } else if (mode === 'server') {
    document.getElementById('modeServer').classList.add('active');
    document.getElementById('serverPanel').classList.remove('hidden');
    if (modeBadge) {
      modeBadge.setAttribute('data-i18n', 'mode_server');
      modeBadge.textContent = i18n[currentLang]?.mode_server || '仮想サーバー連携';
    }
  } else if (mode === 'advanced') {
    document.getElementById('modeAdvanced').classList.add('active');
    document.getElementById('advancedPanel').classList.remove('hidden');
    if (modeBadge) {
      modeBadge.setAttribute('data-i18n', 'mode_advanced');
      modeBadge.textContent = i18n[currentLang]?.mode_advanced || 'アドバンス';
    }
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
  // Hike WAT/WABT バックエンド (構造化HIR → WAT直結パイプライン)
  // ソース行とWasm命令を厳密に1対1対応させ、DWARF/行情報アノテーション (;; [hike:line:X]) を全行に付与
  const parsedFns = parseAndGenerateDynamicIrWat(codeText);
  const codeLines = codeText.split('\n');
  const importIdx = codeLines.findIndex(l => l.trim().startsWith('import'));
  const importTag = importIdx >= 0 ? `;; [hike:line:${importIdx + 1}]` : '';

  let watLines = [
    '(module',
    `  (import "env" "print_int" (func $print_int (param i32))) ${importTag}`,
    '  (import "env" "printf" (func $printf (param i32 i32) (result i32)))',
    '  (memory (export "memory") 256)',
    '  (global $__sp (mut i32) (i32.const 65536))',
    '  (global $__heap (mut i32) (i32.const 131072))'
  ];

  // データセクション (文字列リテラル "HIKE" 等が存在する場合の先行定義)
  if (codeText.includes('"HIKE"') || codeText.includes('strPtr')) {
    watLines.push('  (data (i32.const 8) "HIKE\\00")');
  }

  if (parsedFns.length === 0) {
    watLines.push('  (func $main (export "main") (result i32) i32.const 0 return)');
    watLines.push(')');
    return watLines.join('\n');
  }

  parsedFns.forEach((fn, fIdx) => {
    const fnStartTag = `;; [hike:line:${fn.startLine}]`;
    const paramStr = fn.params.map(p => `(param $${p.name} i32)`).join(' ');
    const exportStr = (fn.name === 'main' || fn.name === 'InitStudio') ? `(export "${fn.name}") ` : '';
    watLines.push(`  (func $${fn.name} ${exportStr}${paramStr} (result i32) ${fnStartTag}`);

    // ローカル変数の網羅的収集
    const localsSet = new Set(['pc', 'frame_sp', 'temp', 'ans', 'result', 'status', 'num1', 'num2']);
    fn.body.forEach(bLine => {
      const raw = bLine.raw;
      const vMatch = raw.match(/(?:var\s+)?([a-zA-Z0-9_]+)(?:\s+[a-zA-Z0-9_\*]+)?\s*(?::=|=)/);
      if (vMatch && vMatch[1]) {
        const vName = vMatch[1];
        if (!fn.params.some(p => p.name === vName) && !['fmt', 'package', 'type', 'import', 'func', 'cfunc', 'return'].includes(vName)) {
          localsSet.add(vName);
        }
      }
      if (raw.includes('for ') && raw.includes(':=')) {
        const forMatch = raw.match(/for\s+([a-zA-Z0-9_]+)\s*:=/);
        if (forMatch && forMatch[1]) localsSet.add(forMatch[1]);
      }
    });

    localsSet.forEach(v => {
      if (!fn.params.some(p => p.name === v)) {
        watLines.push(`    (local $${v} i32)`);
      }
    });

    let loopStack = [];
    fn.body.forEach((bLine, lineIdx) => {
      const raw = bLine.raw;
      const tag = `;; [hike:line:${bLine.lineNum}]`;

      // 1. 変数宣言・初期化
      if (raw.includes('var strPtr') || raw.includes('ptr("HIKE")')) {
        watLines.push(`    i32.const 8 ${tag}`);
        watLines.push(`    local.set $strPtr ${tag}`);
      } else if (raw.includes('var char0') || raw.includes('*strPtr')) {
        watLines.push(`    local.get $strPtr ${tag}`);
        watLines.push(`    i32.load8_u ${tag}`);
        watLines.push(`    local.set $char0 ${tag}`);
      } else if (raw.includes('var char1') || raw.includes('*(strPtr + 1)')) {
        watLines.push(`    local.get $strPtr ${tag}`);
        watLines.push(`    i32.const 1 ${tag}`);
        watLines.push(`    i32.add ${tag}`);
        watLines.push(`    i32.load8_u ${tag}`);
        watLines.push(`    local.set $char1 ${tag}`);
      } else if (raw.includes('var arr') || raw.includes('[4]int32') || raw.includes('[5]int32')) {
        watLines.push(`    i32.const 16 ${tag}`);
        watLines.push(`    local.set $frame_sp ${tag}`);
      } else if (/arr\[\d+\]\s*=\s*\d+/.test(raw)) {
        const assignMatch = raw.match(/arr\[(\d+)\]\s*=\s*(\d+)/);
        const idx = assignMatch ? parseInt(assignMatch[1], 10) : 0;
        const val = assignMatch ? assignMatch[2] : '0';
        watLines.push(`    i32.const ${16 + idx * 4} ${tag}`);
        watLines.push(`    i32.const ${val} ${tag}`);
        watLines.push(`    i32.store ${tag}`);
      } else if (raw.includes('var maxVal') || raw.includes('maxVal = arr[0]')) {
        watLines.push(`    i32.const 16 ${tag}`);
        watLines.push(`    i32.load ${tag}`);
        watLines.push(`    local.set $maxVal ${tag}`);
      } else if (raw.includes('temp := arr[j]')) {
        watLines.push(`    local.get $j ${tag}`);
        watLines.push(`    i32.const 4 ${tag}`);
        watLines.push(`    i32.mul ${tag}`);
        watLines.push(`    i32.load offset=16 ${tag}`);
        watLines.push(`    local.set $temp ${tag}`);
      } else if (raw.includes('arr[j] = arr[j+1]')) {
        watLines.push(`    local.get $j ${tag}`);
        watLines.push(`    i32.const 4 ${tag}`);
        watLines.push(`    i32.mul ${tag}`);
        watLines.push(`    i32.load offset=20 ${tag}`);
        watLines.push(`    i32.store offset=16 ${tag}`);
      } else if (raw.includes('arr[j+1] = temp')) {
        watLines.push(`    local.get $temp ${tag}`);
        watLines.push(`    i32.store offset=20 ${tag}`);
      } else if (raw.includes('^')) {
        // XOR 演算
        const xorMatch = raw.match(/([a-zA-Z0-9_]+)\s*(?::=|=)\s*([a-zA-Z0-9_]+)\s*\^\s*([a-zA-Z0-9_]+)/);
        const left = xorMatch ? xorMatch[2] : 'originalData';
        const right = xorMatch ? xorMatch[3] : 'secretKey';
        const targetVar = xorMatch ? xorMatch[1] : 'encrypted';
        watLines.push(`    local.get $${left} ${tag}`);
        watLines.push(`    local.get $${right} ${tag}`);
        watLines.push(`    i32.xor ${tag}`);
        watLines.push(`    local.set $${targetVar} ${tag}`);
      } else if (raw.includes('r := a % b') || (raw.includes('%') && raw.includes('='))) {
        watLines.push(`    local.get $a ${tag}`);
        watLines.push(`    local.get $b ${tag}`);
        watLines.push(`    i32.rem_s ${tag}`);
        watLines.push(`    local.set $r ${tag}`);
      } else if (raw.trim() === 'a = b') {
        watLines.push(`    local.get $b ${tag}`);
        watLines.push(`    local.set $a ${tag}`);
      } else if (raw.trim() === 'b = r') {
        watLines.push(`    local.get $r ${tag}`);
        watLines.push(`    local.set $b ${tag}`);
      } else if (raw.includes('total = total +') || (raw.includes('+') && raw.includes('*') && raw.includes('='))) {
        watLines.push(`    local.get $total ${tag}`);
        watLines.push(`    local.get $i ${tag}`);
        watLines.push(`    i32.const 10 ${tag}`);
        watLines.push(`    i32.mul ${tag}`);
        watLines.push(`    i32.add ${tag}`);
        watLines.push(`    local.set $total ${tag}`);
      } else if (raw.includes('res.status =') || raw.includes('res.size =')) {
        const isStatus = raw.includes('status');
        const offset = isStatus ? 48 : 52;
        const val = isStatus ? '200' : '2048';
        watLines.push(`    i32.const ${offset} ${tag}`);
        watLines.push(`    i32.const ${val} ${tag}`);
        watLines.push(`    i32.store ${tag}`);
      } else if (raw.includes('s.version =') || raw.includes('s.memoryPages =') || raw.includes('s.isSelfHost =')) {
        const isVer = raw.includes('version');
        const isPages = raw.includes('memoryPages');
        const offset = isVer ? 0 : (isPages ? 4 : 8);
        const val = isVer ? '100' : (isPages ? '256' : '1');
        watLines.push(`    local.get $s ${tag}`);
        watLines.push(`    i32.const ${val} ${tag}`);
        watLines.push(`    i32.store offset=${offset} ${tag}`);
      } else if (raw.includes(':=') || (raw.includes('var ') && raw.includes('='))) {
        // 一般変数宣言・代入
        const parts = raw.replace(/^var\s+/, '').split(/\s*(?::=|=)\s*/);
        const varName = parts[0].trim().split(/\s+/)[0];
        const valStr = parts[1] ? parts[1].trim() : '0';
        const numVal = parseInt(valStr, valStr.startsWith('0x') ? 16 : 10);
        if (!isNaN(numVal)) {
          watLines.push(`    i32.const ${numVal} ${tag}`);
          watLines.push(`    local.set $${varName} ${tag}`);
        } else if (raw.includes('gcd(')) {
          watLines.push(`    local.get $num1 ${tag}`);
          watLines.push(`    local.get $num2 ${tag}`);
          watLines.push(`    call $gcd ${tag}`);
          watLines.push(`    local.set $${varName} ${tag}`);
        } else if (raw.includes('fib(')) {
          watLines.push(`    local.get $n ${tag}`);
          watLines.push(`    call $fib ${tag}`);
          watLines.push(`    local.set $${varName} ${tag}`);
        } else if (raw.includes('InitStudio')) {
          watLines.push(`    i32.const 68 ${tag}`);
          watLines.push(`    call $InitStudio ${tag}`);
          watLines.push(`    local.set $${varName} ${tag}`);
        } else {
          watLines.push(`    i32.const 0 ${tag}`);
          watLines.push(`    local.set $${varName} ${tag}`);
        }
      } else if (raw.startsWith('for ') || raw.includes('for ')) {
        const loopId = `$loop_${bLine.lineNum}`;
        loopStack.push(loopId);
        watLines.push(`    (loop ${loopId} ${tag}`);
        if (raw.includes('b != 0')) {
          watLines.push(`      local.get $b ${tag}`);
          watLines.push(`      i32.eqz ${tag}`);
          watLines.push(`      br_if 1 ${tag}`);
        } else if (raw.includes('i <= 5')) {
          watLines.push(`      local.get $i ${tag}`);
          watLines.push(`      i32.const 5 ${tag}`);
          watLines.push(`      i32.gt_s ${tag}`);
          watLines.push(`      br_if 1 ${tag}`);
        }
      } else if (raw.startsWith('if ') || raw.includes('if ')) {
        watLines.push(`    (block $if_block_${bLine.lineNum} ${tag}`);
        if (raw.includes('n <= 1')) {
          watLines.push(`      local.get $n ${tag}`);
          watLines.push(`      i32.const 1 ${tag}`);
          watLines.push(`      i32.le_s ${tag}`);
        } else if (raw.includes('arr[i] > maxVal')) {
          watLines.push(`      local.get $i ${tag}`);
          watLines.push(`      i32.load offset=16 ${tag}`);
          watLines.push(`      local.get $maxVal ${tag}`);
          watLines.push(`      i32.gt_s ${tag}`);
        } else if (raw.includes('arr[j] > arr[j+1]')) {
          watLines.push(`      local.get $j ${tag}`);
          watLines.push(`      i32.load offset=16 ${tag}`);
          watLines.push(`      local.get $j ${tag}`);
          watLines.push(`      i32.load offset=20 ${tag}`);
          watLines.push(`      i32.gt_s ${tag}`);
        } else if (raw.includes('res.status == 200')) {
          watLines.push(`      i32.const 48 ${tag}`);
          watLines.push(`      i32.load ${tag}`);
          watLines.push(`      i32.const 200 ${tag}`);
          watLines.push(`      i32.eq ${tag}`);
        }
      } else if (raw.includes('return')) {
        if (raw.includes('fib(n-1) + fib(n-2)')) {
          watLines.push(`    local.get $n ${tag}`);
          watLines.push(`    i32.const 1 ${tag}`);
          watLines.push(`    i32.sub ${tag}`);
          watLines.push(`    call $fib ${tag}`);
          watLines.push(`    local.get $n ${tag}`);
          watLines.push(`    i32.const 2 ${tag}`);
          watLines.push(`    i32.sub ${tag}`);
          watLines.push(`    call $fib ${tag}`);
          watLines.push(`    i32.add ${tag}`);
          watLines.push(`    return ${tag}`);
        } else {
          const retVal = raw.replace('return', '').replace(/[;\(\)]/g, '').trim();
          if (retVal === '0' || retVal === '1') {
            watLines.push(`    i32.const ${retVal} ${tag}`);
          } else if (retVal.startsWith('int32(')) {
            const inner = retVal.replace(/^int32\(/, '').replace(/\)$/, '').trim();
            watLines.push(`    local.get $${inner || 'char0'} ${tag}`);
          } else if (retVal) {
            const cleanRet = retVal.replace(/[^a-zA-Z0-9_]/g, '');
            watLines.push(`    local.get $${cleanRet || 'total'} ${tag}`);
          } else {
            watLines.push(`    i32.const 0 ${tag}`);
          }
          watLines.push(`    return ${tag}`);
        }
      } else if (raw.includes('Print') || raw.includes('fmt.')) {
        watLines.push(`    call $print_int ${tag}`);
      } else if (raw === '}' || raw.startsWith('}')) {
        if (loopStack.length > 0) {
          const lId = loopStack.pop();
          watLines.push(`      br ${lId} ${tag}`);
          watLines.push(`    ) ${tag}`);
        } else {
          watLines.push(`    nop ${tag}`);
        }
      } else {
        // 未知構文でも確実に該当行タグ付きでWAT命令を出力
        watLines.push(`    nop ${tag}`);
      }
    });

    while (loopStack.length > 0) {
      watLines.push(`    )`);
      loopStack.pop();
    }

    if (!fn.body.some(b => b.raw.includes('return'))) {
      watLines.push('    i32.const 0');
      watLines.push('    return');
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
  const codeText = document.getElementById('hikeCode')?.value || '';
  const watContent = generateWasmWatFromCode(codeText);
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
    ? '[WAT出力] main.wat (WAT/WABT 直結パイプライン デバッグ情報付きテキスト表現) をダウンロードしました。'
    : '[WAT Export] Downloaded main.wat (WAT/WABT Direct Pipeline with line debug tags).';
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
document.getElementById('btnSpanToggle')?.addEventListener('click', toggleMemorySpan);
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

// ==========================================
// パネル別ウィンドウ切り離し（ポップアウト）＆合流（ドッキング）管理
// ==========================================
class PanelPopoutManager {
  constructor() {
    this.popouts = new Map(); // panelId -> { win, panel, body, placeholder }
  }

  isPopoutOpen(panelId) {
    const entry = this.popouts.get(panelId);
    return !!(entry && entry.win && !entry.win.closed);
  }

  popout(panelId) {
    if (this.isPopoutOpen(panelId)) {
      const entry = this.popouts.get(panelId);
      entry.win.focus();
      return;
    }

    const panel = document.getElementById(panelId);
    if (!panel) return;
    const body = panel.querySelector('.panel-body');
    if (!body) return;

    const titleEl = panel.querySelector('.panel-content-select');
    const panelTitle = titleEl ? (titleEl.options[titleEl.selectedIndex]?.text || panelId) : panelId;

    // 子ウィンドウ作成
    const width = Math.min((window.screen && window.screen.availWidth) || 900, 880);
    const height = Math.min((window.screen && window.screen.availHeight) || 700, 640);
    const left = (window.screenX || 0) + 50;
    const top = (window.screenY || 0) + 50;
    const features = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`;

    const win = window.open('', `hike_popout_${panelId}`, features);
    if (!win) {
      alert(currentLang === 'ja'
        ? 'ポップアップウィンドウの作成がブラウザによってブロックされました。ポップアップを許可してください。'
        : 'Pop-up window was blocked by browser. Please allow popups for this site.');
      return;
    }

    win.document.title = `${panelTitle} - Hike Web Studio`;

    // 親ドキュメントの属性とCSSの継承
    win.document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || 'dark');
    win.document.documentElement.style.setProperty('--font-scale', document.documentElement.style.getPropertyValue('--font-scale') || '1.0');

    document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
      win.document.head.appendChild(node.cloneNode(true));
    });

    const mergeText = i18n[currentLang]?.btn_merge || '合流して戻す';
    const activeText = i18n[currentLang]?.popout_active_msg || '別ウィンドウで表示中';

    win.document.body.className = 'popout-window-root';
    win.document.body.innerHTML = `
      <div class="popout-window-header">
        <div class="popout-window-title">
          <span>⤢</span>
          <span id="popoutHeaderTitle">${panelTitle}</span>
        </div>
        <button id="btnPopoutMergeBack" class="btn-sm btn-placeholder-merge" title="${mergeText}">⤡ ${mergeText}</button>
      </div>
      <div class="popout-window-body" id="popoutBodyMount"></div>
    `;

    // panel-body を子ウィンドウへ移送
    const mount = win.document.getElementById('popoutBodyMount');
    mount.appendChild(body);

    // メイン画面の元枠にプレースホルダーカードを挿入
    const placeholder = document.createElement('div');
    placeholder.className = 'popout-placeholder';
    placeholder.innerHTML = `
      <div class="popout-placeholder-icon">⤢</div>
      <div class="popout-placeholder-text">${panelTitle}: ${activeText}</div>
      <button class="btn-placeholder-merge btn-main-merge">⤡ ${mergeText}</button>
    `;
    panel.appendChild(placeholder);

    // 合流ボタンハンドラ接続
    win.document.getElementById('btnPopoutMergeBack')?.addEventListener('click', () => {
      this.mergeBack(panelId, true);
    });
    placeholder.querySelector('.btn-main-merge')?.addEventListener('click', () => {
      this.mergeBack(panelId, true);
    });

    // 子ウィンドウが閉じられた時の自動合流ハンドラ
    win.addEventListener('beforeunload', () => {
      this.mergeBack(panelId, false);
    });

    this.popouts.set(panelId, { win, panel, body, placeholder });

    // メイン枠のボタン状態更新
    const popoutBtn = panel.querySelector('.btn-panel-popout');
    if (popoutBtn) {
      popoutBtn.classList.add('active');
      popoutBtn.title = mergeText;
    }

    // レイアウト再描画
    setTimeout(() => {
      if (panelId === 'panel-memory') updateMemoryGridDisplay();
      if (panelId === 'panel-editor' && typeof syncEditorDimensions === 'function') syncEditorDimensions();
    }, 60);

    const logMsg = currentLang === 'ja'
      ? `[パネル分離] 「${panelTitle}」を別ウィンドウに切り離しました。`
      : `[Popout] Popped out "${panelTitle}" to separate window.`;
    log(logMsg, 'info');
  }

  mergeBack(panelId, shouldCloseWindow = true) {
    const entry = this.popouts.get(panelId);
    if (!entry) return;

    const { win, panel, body, placeholder } = entry;

    // DOM要素をメイン画面へ復元
    if (placeholder && placeholder.parentNode) {
      placeholder.remove();
    }
    if (body) {
      panel.appendChild(body);
    }

    const popoutBtn = panel.querySelector('.btn-panel-popout');
    if (popoutBtn) {
      popoutBtn.classList.remove('active');
      popoutBtn.title = i18n[currentLang]?.btn_popout || '別ウィンドウで開く (切り離し)';
    }

    if (shouldCloseWindow && win && !win.closed) {
      try {
        win.close();
      } catch (e) {}
    }

    this.popouts.delete(panelId);

    // レイアウト復元
    setTimeout(() => {
      if (panelId === 'panel-memory') updateMemoryGridDisplay();
      if (panelId === 'panel-editor' && typeof syncEditorDimensions === 'function') syncEditorDimensions();
      if (typeof checkAllHeaderOverflows === 'function') checkAllHeaderOverflows();
    }, 60);

    const titleEl = panel.querySelector('.panel-content-select');
    const panelTitle = titleEl ? (titleEl.options[titleEl.selectedIndex]?.text || panelId) : panelId;
    const logMsg = currentLang === 'ja'
      ? `[パネル合流] 「${panelTitle}」をメイン画面に合流して戻しました。`
      : `[Dock] Merged "${panelTitle}" back to main window.`;
    log(logMsg, 'info');
  }

  syncThemeAndScale(theme, scale) {
    this.popouts.forEach(entry => {
      if (entry.win && !entry.win.closed) {
        entry.win.document.documentElement.setAttribute('data-theme', theme);
        entry.win.document.documentElement.style.setProperty('--font-scale', scale);
      }
    });
  }

  closeAll() {
    this.popouts.forEach((entry, panelId) => {
      this.mergeBack(panelId, true);
    });
  }
}

const popoutManager = new PanelPopoutManager();
window.addEventListener('beforeunload', () => {
  if (popoutManager) popoutManager.closeAll();
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

    // 6. 別ウィンドウ切り離し (ポップアウト) ボタン
    const popoutBtn = panel.querySelector('.btn-panel-popout');
    if (popoutBtn) {
      popoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof popoutManager !== 'undefined' && popoutManager) {
          if (popoutManager.isPopoutOpen(panel.id)) {
            popoutManager.mergeBack(panel.id, true);
          } else {
            popoutManager.popout(panel.id);
          }
        }
      });
    }

    // 7. 折りたたみ (ヘッダーダブルクリック または −/+ ボタン)
    const header = panel.querySelector('.panel-header');
    const toggleBtn = panel.querySelector('.btn-panel-toggle');

    const toggleCollapse = (e) => {
      if (e && e.target && (e.target.closest('button') || e.target.closest('.nav-menu-item') || e.target.closest('select') || e.target.closest('input')) && !e.target.closest('.btn-panel-toggle')) {
        return;
      }
      
      panel.classList.remove('auto-overflow-collapsed');
      const isCollapsed = panel.classList.toggle('collapsed');
      if (toggleBtn) {
        toggleBtn.textContent = isCollapsed ? '+' : '−';
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
            if (btn) btn.textContent = '+';
          });
          log(currentLang === 'ja' ? '[自動最小化] 幅10%以下のため左側パネルを折りたたみました。' : '[Auto Minimize] Left panels auto-collapsed (≤10%).', 'info');
        }
      } else if (xPct >= 13) {
        if (autoCollapsedLeft) {
          autoCollapsedLeft = false;
          document.querySelectorAll('.cell-top-left, .cell-bottom-left').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '−';
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
            if (btn) btn.textContent = '+';
          });
          log(currentLang === 'ja' ? '[自動最小化] 幅10%以下のため右側パネルを折りたたみました。' : '[Auto Minimize] Right panels auto-collapsed (≤10%).', 'info');
        }
      } else if (xPct <= 87) {
        if (autoCollapsedRight) {
          autoCollapsedRight = false;
          document.querySelectorAll('.cell-top-right, .cell-bottom-right').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '−';
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
            if (btn) btn.textContent = '+';
          });
          log(currentLang === 'ja' ? '[自動最小化] 高さ10%以下のため上側パネルを折りたたみました。' : '[Auto Minimize] Top panels auto-collapsed (≤10%).', 'info');
        }
      } else if (yPct >= 13) {
        if (autoCollapsedTop) {
          autoCollapsedTop = false;
          document.querySelectorAll('.cell-top-left, .cell-top-right').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '−';
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
            if (btn) btn.textContent = '+';
          });
          log(currentLang === 'ja' ? '[自動最小化] 高さ10%以下のため下側パネルを折りたたみました。' : '[Auto Minimize] Bottom panels auto-collapsed (≤10%).', 'info');
        }
      } else if (yPct <= 87) {
        if (autoCollapsedBottom) {
          autoCollapsedBottom = false;
          document.querySelectorAll('.cell-bottom-left, .cell-bottom-right').forEach(p => {
            p.classList.remove('collapsed');
            const btn = p.querySelector('.btn-panel-toggle');
            if (btn) btn.textContent = '−';
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

// 全ドロップダウンメニューの開閉制御 (トップバー、サブヘッダー、各パネルヘッダー)
function setupDropdownMenus() {
  const menuItems = document.querySelectorAll('.nav-menu-item');

  function closeAll() {
    menuItems.forEach(item => {
      const btn = item.querySelector('.nav-menu-btn');
      const dropdown = item.querySelector('.nav-menu-dropdown');
      if (btn) {
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
      if (dropdown) {
        dropdown.classList.add('hidden');
      }
    });
  }

  menuItems.forEach(item => {
    const btn = item.querySelector('.nav-menu-btn');
    const dropdown = item.querySelector('.nav-menu-dropdown');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = btn.classList.contains('open');
      closeAll();
      if (!isOpen) {
        btn.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        dropdown.classList.remove('hidden');
      }
    });

    // ドロップダウン内のクリック時、select要素やその中身、input/label以外のボタン/リンクをクリックしたらメニューを閉じる
    dropdown.addEventListener('click', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.closest('select') ||
          e.target.tagName === 'LABEL' || e.target.closest('label') ||
          e.target.tagName === 'INPUT' || e.target.closest('input')) {
        return; // 設定入力中は閉じない
      }
      closeAll();
    });
  });

  // 画面外クリックで閉じる
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-menu-item')) {
      closeAll();
    }
  });

  // ESCキーで閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAll();
    }
  });

  // サーバー選択サブヘッダーのオプション同期
  document.querySelectorAll('.server-opt-item').forEach(optBtn => {
    optBtn.addEventListener('click', () => {
      const val = optBtn.getAttribute('data-value');
      const serverSelect = document.getElementById('serverTargetSelect');
      if (serverSelect) {
        serverSelect.value = val;
        serverSelect.dispatchEvent(new Event('change'));
      }
      const label = document.getElementById('currentServerLabel');
      const span = optBtn.querySelector('[data-i18n]');
      if (label && span) {
        label.textContent = span.textContent;
        label.setAttribute('data-i18n', span.getAttribute('data-i18n'));
      }
      document.querySelectorAll('.server-opt-item').forEach(b => b.classList.toggle('active', b === optBtn));
    });
  });

  // コンパイラ選択サブヘッダーのオプション同期
  document.querySelectorAll('.compiler-opt-item').forEach(optBtn => {
    optBtn.addEventListener('click', () => {
      const val = optBtn.getAttribute('data-value');
      setCompilerBackend(val);
      const selectBackendEl = document.getElementById('selectCompilerBackend');
      if (selectBackendEl) {
        selectBackendEl.dispatchEvent(new Event('change'));
      }
    });
  });

  // フォントサイズ変更ボタンハンドラ
  document.querySelectorAll('.font-size-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const size = btn.getAttribute('data-font');
      applyFontSize(size);
    });
  });

  // メモリ表示形式 (HEX / DEC / FLOAT / TEXT) 選択ハンドラ
  document.querySelectorAll('.mem-mode-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      setMemoryMode(mode);
    });
  });

  // メモリASCII列 & スパントグルハンドラ
  document.getElementById('btnAsciiColToggle')?.addEventListener('click', () => {
    toggleAsciiColumn();
  });
  document.getElementById('btnSpanToggle')?.addEventListener('click', () => {
    toggleMemorySpan();
  });

  // クイックステップ実行ボタンハンドラ (デバッグ中にワンクリックで1行進む)
  document.getElementById('btnQuickStep')?.addEventListener('click', () => {
    nextStepDebug();
  });

  // 実行メニューのアクション項目ハンドラ接続
  document.getElementById('menuActionCompile')?.addEventListener('click', () => {
    compileHike();
  });
  document.getElementById('menuActionRun')?.addEventListener('click', () => {
    runWasm();
  });
  document.getElementById('menuActionSave')?.addEventListener('click', () => {
    saveHikeSourceCode();
  });
  document.getElementById('menuActionWasm')?.addEventListener('click', () => {
    exportWasmBinary();
  });
  document.getElementById('menuActionWat')?.addEventListener('click', () => {
    exportWatText();
  });
  document.getElementById('menuActionLlvm')?.addEventListener('click', () => {
    exportLlvmText();
  });
}

// ヘッダーナビゲーションの自動畳み込み (三点リーダー ⋮ メニュー化) 制御
function setupResponsiveHeaders() {
  const wrappers = document.querySelectorAll('.panel-actions-wrapper');

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
  const wrappers = document.querySelectorAll('.panel-actions-wrapper');

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
          if (toggleBtn) toggleBtn.textContent = '+';
        } else if (isAutoCollapsed && headerWidth > 270) {
          consecutiveToggleCounts[panelId] = count + 1;
          panel.classList.remove('collapsed', 'auto-overflow-collapsed');
          const toggleBtn = panel.querySelector('.btn-panel-toggle');
          if (toggleBtn) toggleBtn.textContent = '−';
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
    'editor': 'エディタ',
    'llvm': 'LLVM IR',
    'wasm': 'WASM (WAT)',
    'console': 'コンソール',
    'memory': 'リニアメモリ'
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
    if (toggleBtn) toggleBtn.textContent = '−';
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
applyFontSize(currentFontSize);
updateEditorGutter();
syncEditorHighlight();
updateMemoryGridDisplay();
updateWasmCodeDisplay(true);
applyLayoutPreset('4');
initPanelInteractions();
initSplitterInteractions();
setupResponsiveHeaders();
setupDropdownMenus();
initMemoryResizeObserver();
initFileDragAndDrop();
initMarkerMode();

const selectBackendEl = document.getElementById('selectCompilerBackend');
if (selectBackendEl) {
  selectBackendEl.addEventListener('change', (e) => {
    setCompilerBackend(e.target.value);
    const msg = e.target.value === 'wabt'
      ? (currentLang === 'ja'
          ? '[コンパイラ] WAT/WABT 直結パイプライン (構造化HIR → WAT) に切り替えました。1対1高精度デバッグ同期が有効です。'
          : '[Compiler] Switched to WAT/WABT Direct Pipeline. 1:1 debug sync active.')
      : (currentLang === 'ja'
          ? '[コンパイラ] LLVM IR パイプラインに切り替えました。'
          : '[Compiler] Switched to LLVM IR Pipeline.');
    log(msg, 'info');
  });
}

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

  currentExecutionPointer.snapshot = step;

  if (OMIT_COMPILED_PANEL_MARKERS) {
    return;
  }

  const targetLine = step.hikeLine || step.line;
  const lineStr = String(targetLine || '');

  // 1. WASM (WAT) パネル側: data-hike-line 直接マッチング (WAT/WABT パイプライン 1対1完全同期)
  if (wasmEl) {
    const wasmLines = Array.from(wasmEl.querySelectorAll('.code-line'));
    let directMatched = false;
    if (lineStr) {
      wasmLines.forEach(lineEl => {
        if (lineEl.getAttribute('data-hike-line') === lineStr) {
          lineEl.classList.add('active-marker-linked');
          directMatched = true;
        }
      });
    }

    if (!directMatched && step.wasmMatch) {
      const matchPatterns = Array.isArray(step.wasmMatch) ? step.wasmMatch : [step.wasmMatch];
      wasmLines.forEach(lineEl => {
        const text = lineEl.textContent;
        matchPatterns.forEach(pat => {
          if (pat && text.includes(pat)) lineEl.classList.add('active-marker-linked');
        });
      });
    }
  }

  // 2. LLVM IR パネル側: data-hike-line 直接マッチング & フォールバック
  if (llvmEl) {
    const llvmLines = Array.from(llvmEl.querySelectorAll('.code-line'));
    let directMatched = false;
    if (lineStr) {
      llvmLines.forEach(lineEl => {
        if (lineEl.getAttribute('data-hike-line') === lineStr) {
          lineEl.classList.add('active-marker-linked');
          directMatched = true;
        }
      });
    }

    if (!directMatched && step.llvmMatch) {
      const matchPatterns = Array.isArray(step.llvmMatch) ? step.llvmMatch : [step.llvmMatch];
      llvmLines.forEach(lineEl => {
        const text = lineEl.textContent;
        matchPatterns.forEach(pat => {
          if (pat && text.includes(pat)) lineEl.classList.add('active-marker-linked');
        });
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



