# Hike Web Studio

> In-browser WebAssembly Compiler, Step Debugger & Linear Memory Visualizer for the Hike Programming Language.

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Web / Browser](https://img.shields.io/badge/platform-Modern%20Web%20Browsers-brightgreen.svg)

[English](./README.en.md) | **日本語**

> ℹ️ **言語に関する注記**: 本ドキュメント（日本語版）が本プロジェクトの**正式な原本（Single Source of Truth / 真）**です。[英語版 (README.en.md)](./README.en.md) はAIによって翻訳された補助ドキュメントであり、記述や解釈に差異がある場合はこの日本語版の内容が優先されます。

---

## 📖 概要 (Overview)

**Hike Web Studio** は、ブラウザ上だけで動作する [Hike 言語](https://github.com/kanryu/hike-lang) 向けの統合開発・デバッグ学習環境（Web IDE & Playground）です。

サーバーサイドのバックエンドに依存せず、ブラウザ内のみで Hike ソースコードから LLVM IR および WebAssembly (WAT/WASM) の動的トランスパイル・ビルドを行い、ステップ実行によるメモリ状態・変数・コールスタックの遷移をリアルタイムに追跡できます。

> **💡 開発コンセプト & 制作意図**  
> **「C言語や本格的なアセンブリに進む前の『最初のウォーミングアップ』として、ポインタやバイナリの感覚を掴むのに最高の教材を作りたい」**  
> Segmentation Fault や複雑なレジスタ操作で挫折することなく、ブラウザ完結でメモリ領域や文字コード（ASCII/UTF-8）が色づく体験を通じて、低レイヤの基礎感覚を自然と体得できます。

---

## 🌟 主な機能 (Features)

### 1. ⚡ インブラウザ動的コンパイル (Single Source of Truth)
* **Hike → LLVM IR & WASM (WAT) トランスパイル**:
  * Hike ソースコードの記述内容を真（Single Source of Truth）として、リアルタイムに LLVM IR および WAT テキストを自動生成。
  * `main.hike`, `main.ll`, `main.wat`, `main.wasm` のダウンロード・エクスポート機能に対応。

### 2. ⏭️ ビジュアル・ステップデバッガー
* **HIKE コード実行ポイント追従**:
  * ステップ実行（F10）、自動ステップ実行（2秒間隔）、ブレークポイントスキップ（F5）に対応。
  * 実行行インジケーターとガターハイライトにより、現在の実行ポイントを HIKE コード上で直感的に可視化。
  * 将来的な WebAssembly / LLVM IR 命令レベルの同期表示にも対応可能な内部ポインタ管理アーキテクチャを内包。

### 3. 🔍 リニアメモリ・可視化ビューア (Zero-GC Heap View)
* **リアルタイム・メモリダンプ表示**:
  * 32ビット整数（リトルエンディアン）やバイト列の書き込み・変更箇所をアニメーション強調。
  * 16進数 (HEX) と 10進数 (DEC) のワンクリック表示切り替え。
  * 表示行数の拡張（64〜256バイト以上のダンプ表示対応）。
* **変数 & スタックウォッチ (Watch Panel)**:
  * ローカル変数、構造体フィールド、戻り値、コールスタック情報を表形式で即座に確認。

### 4. 📚 充実の学習用演習例題 (Exercises 1〜9)
初心者から低レイヤ学習者までをカバーするビルトイン例題をワンクリックでロード可能：
1. **演習 1: 総和計算** (ループと変数の基礎)
2. **演習 2: 文字列リテラルとポインタ操作** (メモリ上のASCII文字コード配置)
3. **演習 3: 配列要素の最大値探索** (配列アクセスと分岐)
4. **演習 4: ユークリッドの互除法 (GCD)** (関数呼び出しと剰余算アルゴリズム)
5. **演習 5: バブルソート** (配列のスワップとメモリ書き換え追跡)
6. **演習 6: XOR データ暗号化と復号** (ビット演算とセキュリティ基礎)
7. **演習 7: 再帰関数 (フィボナッチ数列)** (コールスタックとフレームの伝搬)
8. **演習 8: Web API HTTP レスポンスパース** (構造体のメモリ配置と仮想通信ノード連携)
9. **演習 9: Studio 自身のセルフコンパイル** (16MB リニアメモリ確保とセルフホスト構造)

### 5. 🖥️ 柔軟な IDE レイアウト & 多言語対応
* **マルチレイアウトプリセット**: 4枠(2×2)、3枠、2枠(左右/上下)、1枠(全画面)などの配置切替。
* **ドラッグ＆ドロップ**: パネルの移動・位置入れ替え、スプリッターによる境界線の自由リサイズ。
* **テーマ & 言語切り替え**: ダーク/ライトテーマ、日本語/英語 (JP/EN) のワンタッチ切替。

---

## ⌨️ ショートカットキー (Keybindings)

| キー | 動作 |
| :--- | :--- |
| <kbd>F10</kbd> | 1行ステップ実行 (Step Over) |
| <kbd>F5</kbd> | 次のブレークポイントまでスキップ (Continue) |
| 行番号クリック | ブレークポイントの設置 / 解除 |
| ヘッダーダブルクリック | パネルの折りたたみ / 展開 |

---

## 📂 ディレクトリ構成 (Directory Structure)

```text
hike-web-studio/
├── index.html            # メイン Studio IDE インターフェース
├── style.css             # スタイルシート (ダーク/ライトテーマ、分割グリッド)
├── app.js                # コアロジック (コンパイラ、デバッガ、仮想メモリ)
├── manual.html           # 取扱説明書 & ガイドライン
├── examples.html         # 例題解説 & 教材活用ガイド
├── examples/             # 演習用 Hike ソースファイル (.hike)
├── modules/              # 再利用可能モジュール定義
├── mock-api/             # 仮想通信サーバー連携モック
├── package.json          # プロジェクト定義
├── LICENSE               # MIT ライセンス
└── README.md             # 本ドキュメント
```

---

## 🚀 使い方 (Getting Started)

特別なビルドツールや Node.js サーバーは必須ではありません。静的ファイルをホストするだけで動作します。

```bash
# リポジトリのクローン
git clone https://github.com/Kinoshita-Keita3/hike-web-studio.git
cd hike-web-studio

# 任意のローカルWebサーバーで配信 (例: npx serve, python http.server など)
npx serve .
# または
python -m http.server 8080
```

ブラウザで `http://localhost:8080` (または表示されたURL) にアクセスしてご利用ください。

---

## 🔗 関連リンク (Related Links)

* **Hike プログラミング言語 公式リポジトリ**: [https://github.com/kanryu/hike-lang](https://github.com/kanryu/hike-lang)
* **Hike Web Studio リポジトリ**: [https://github.com/Kinoshita-Keita3/hike-web-studio](https://github.com/Kinoshita-Keita3/hike-web-studio)

---

## 📄 ライセンス (License)

本プロジェクトは **[MIT License](./LICENSE)** の下で公開されています。

Copyright (c) 2026 HIKE Project / HIKE contributors
