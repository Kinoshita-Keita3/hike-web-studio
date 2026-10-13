# Hike Web Studio

> In-browser WebAssembly Compiler, Step Debugger & Linear Memory Visualizer for the Hike Programming Language.

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Web / Browser](https://img.shields.io/badge/platform-Modern%20Web%20Browsers-brightgreen.svg)

**English** | [日本語 (Original)](./README.md)

> ⚠️ **Notice on Language & Single Source of Truth**:  
> This English document is translated by AI for convenience, with the **[Japanese version (README.md)](./README.md)** serving as the **authoritative single source of truth (真)**. In case of any discrepancy, ambiguity, or conflict between the translations, the Japanese version shall take precedence.

---

## 📖 Overview

**Hike Web Studio** is an in-browser integrated development and debugging learning environment (Web IDE & Playground) for the [Hike programming language](https://github.com/kanryu/hike-lang).

Operating entirely client-side without requiring any backend server, it dynamically transpiles Hike source code into LLVM IR and WebAssembly (WAT/WASM), allowing you to step through execution and monitor memory states, variables, and call stacks in real time.

> **💡 Development Concept & Purpose**  
> **"Create the ultimate warmup learning tool for grasping pointers and raw binary concepts before moving on to C or full assembly language."**  
> Without getting discouraged by Segmentation Faults or complex CPU register sets, learners can naturally develop an intuition for low-level systems through an interactive browser experience where memory addresses and ASCII/UTF-8 character codes illuminate and update in real time.

---

## 🌟 Key Features

### 1. ⚡ Dynamic In-Browser Compilation (Single Source of Truth)
* **Hike → LLVM IR & WebAssembly (WAT) Transpilation**:
  * Treats the Hike code editor as the single source of truth to dynamically compile and generate valid LLVM IR and WAT code.
  * Direct export and download of `main.hike`, `main.ll`, `main.wat`, and `main.wasm`.

### 2. ⏭️ Visual Step Debugger
* **Strict HIKE Code Execution Point Display**:
  * Full support for Step Over (<kbd>F10</kbd>), Auto-Step (2-second interval), and Breakpoint Skip / Continue (<kbd>F5</kbd>).
  * Clear active line indicator and editor gutter highlighting that focuses strictly on the Hike source code.
  * Preserves underlying instruction-level pointer tracking internally for future dual-panel visualization support.

### 3. 🔍 Linear Memory Visualizer (Zero-GC Heap View)
* **Real-time Memory Dump Table**:
  * Visual highlights and animations on changed Little-Endian 32-bit integers and byte sequences.
  * One-click toggle between Hexadecimal (HEX) and Decimal (DEC) formats.
  * Multi-row inspection support (64 to 256+ bytes).
* **Variable & Stack Watch Panel**:
  * Real-time tabular tracking of local variables, struct fields, return codes, and call stacks.

### 4. 📚 Built-in Learning Exercises (Exercises 1 through 9)
Preloaded sample codes covering fundamentals up to advanced systems concepts:
1. **Exercise 1: Sum Calculation** (Basics of loops and local variables)
2. **Exercise 2: String Literals & Pointer Operations** (Inspecting ASCII character codes in linear memory)
3. **Exercise 3: Array Maximum Search** (Array indexing and conditional branching)
4. **Exercise 4: Euclidean Algorithm (GCD)** (Function calls, call stack, and modulo arithmetic)
5. **Exercise 5: Bubble Sort** (Array swapping and memory mutation tracking)
6. **Exercise 6: XOR Data Encryption & Decryption** (Bitwise operations and crypto fundamentals)
7. **Exercise 7: Recursive Functions (Fibonacci)** (Call stacks, recursion frames, and return unwinding)
8. **Exercise 8: Web API HTTP Response Parser** (Struct memory layouts and virtual network node simulation)
9. **Exercise 9: Self-Compiling the Studio Engine** (16MB linear memory allocation and self-host compiler architecture)

### 5. 🖥️ Customizable IDE Layout & Multilingual UI
* **Layout Presets**: Switch between 4-panel (2×2), 3-panel, 2-panel (horizontal/vertical), and 1-panel (fullscreen).
* **Drag-and-Drop Splitters**: Freely reposition panels and drag splitters to resize panes.
* **Theme & Language Toggles**: Instant switching between Dark / Light theme and Japanese / English UI.

---

## ⌨️ Keybindings

| Key | Action |
| :--- | :--- |
| <kbd>F10</kbd> | Step Over (Advance 1 statement) |
| <kbd>F5</kbd> | Continue (Skip to next breakpoint) |
| Click on line number | Set / Remove Breakpoint |
| Double-click header | Collapse / Expand panel |

---

## 📂 Directory Structure

```text
hike-web-studio/
├── index.html            # Main Studio IDE Interface
├── style.css             # UI styling (Dark/Light themes, responsive grid)
├── app.js                # Core engine (Compiler, debugger, virtual memory)
├── manual.html           # User manual and safety guidelines
├── examples.html         # Detailed exercise walkthroughs & curriculum guide
├── examples/             # Hike sample source code files (.hike)
├── modules/              # Reusable Hike module definitions
├── mock-api/             # Mock virtual server integration files
├── package.json          # Project metadata
├── LICENSE               # MIT License
├── README.md             # Japanese documentation (Authoritative Original)
└── README.en.md          # English documentation (AI Translated)
```

---

## 🚀 Getting Started

No build tools or backend servers are required. Hike Web Studio runs as a pure static web app:

```bash
# Clone the repository
git clone https://github.com/hike-lang/hike-web-studio.git
cd hike-web-studio

# Serve using any local HTTP static server (e.g., npx serve, python http.server)
npx serve .
# or
python -m http.server 8080
```

Open `http://localhost:8080` (or the URL shown in your terminal) in any modern web browser.

---

## 📄 License

This project is licensed under the **[MIT License](./LICENSE)**.

Copyright (c) 2026 HIKE Project / HIKE contributors

