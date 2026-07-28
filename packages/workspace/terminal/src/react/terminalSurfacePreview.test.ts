import assert from "node:assert/strict";
import test from "node:test";
import type { IBufferCell, Terminal } from "@xterm/xterm";
import type { TerminalTheme } from "../contracts/index.ts";
import { createTerminalPreviewSnapshot } from "./terminalSurfacePreview.ts";

const theme: TerminalTheme = {
  background: "#111111",
  foreground: "#eeeeee"
};

type CellSpec = {
  bgColor?: number;
  bgDefault?: boolean;
  bgPalette?: boolean;
  bgRgb?: boolean;
  bold?: boolean;
  chars?: string;
  dim?: boolean;
  fgColor?: number;
  fgDefault?: boolean;
  fgPalette?: boolean;
  fgRgb?: boolean;
  inverse?: boolean;
  invisible?: boolean;
  italic?: boolean;
  overline?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  width?: number;
};

function createCell(spec: CellSpec = {}): IBufferCell {
  return {
    getBgColor: () => spec.bgColor ?? 0,
    getChars: () => spec.chars ?? "",
    getFgColor: () => spec.fgColor ?? 0,
    getWidth: () => spec.width ?? 1,
    isBgDefault: () => spec.bgDefault ?? true,
    isBgPalette: () => spec.bgPalette ?? false,
    isBgRGB: () => spec.bgRgb ?? false,
    isBold: () => (spec.bold ? 1 : 0),
    isDim: () => (spec.dim ? 1 : 0),
    isFgDefault: () => spec.fgDefault ?? true,
    isFgPalette: () => spec.fgPalette ?? false,
    isFgRGB: () => spec.fgRgb ?? false,
    isInverse: () => (spec.inverse ? 1 : 0),
    isInvisible: () => (spec.invisible ? 1 : 0),
    isItalic: () => (spec.italic ? 1 : 0),
    isOverline: () => (spec.overline ? 1 : 0),
    isStrikethrough: () => (spec.strikethrough ? 1 : 0),
    isUnderline: () => (spec.underline ? 1 : 0)
  } as unknown as IBufferCell;
}

function createTerminal(input: {
  cols?: number;
  cursorX?: number;
  cursorY?: number;
  rows?: number;
  viewportY?: number;
  lines: Array<Array<CellSpec | null>>;
}): Terminal {
  const cols = input.cols ?? 8;
  const rows = input.rows ?? input.lines.length;
  const lineCells = input.lines.map((line) =>
    line.map((cell) => (cell ? createCell(cell) : null))
  );

  return {
    cols,
    rows,
    options: {
      theme
    },
    buffer: {
      active: {
        cursorX: input.cursorX ?? 0,
        cursorY: input.cursorY ?? 0,
        viewportY: input.viewportY ?? 0,
        getNullCell: () => createCell(),
        getLine(row: number) {
          const cells = lineCells[row];
          if (!cells) {
            return undefined;
          }
          return {
            getCell(column: number, destination?: IBufferCell) {
              const cell = cells[column];
              if (!cell) {
                return undefined;
              }
              if (destination) {
                Object.assign(destination, cell);
                return destination;
              }
              return cell;
            }
          };
        }
      }
    }
  } as unknown as Terminal;
}

function withoutTimestamp(
  snapshot: ReturnType<typeof createTerminalPreviewSnapshot>
) {
  const { updatedAtUnixMs: _updatedAtUnixMs, ...rest } = snapshot;
  return rest;
}

test("terminal surface preview projects blank lines as empty segments", () => {
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      lines: [[{ chars: " " }, { chars: " " }, null]]
    })
  );

  assert.deepEqual(withoutTimestamp(snapshot), {
    cols: 8,
    cursorX: 0,
    cursorY: 0,
    lines: [{ segments: [] }],
    revision: snapshot.revision,
    rows: 1
  });
  assert.equal(snapshot.lines[0]?.segments.length, 0);
});

test("terminal surface preview groups adjacent cells with matching styles", () => {
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      lines: [
        [
          {
            chars: "h",
            fgDefault: false,
            fgPalette: true,
            fgColor: 1
          },
          {
            chars: "i",
            fgDefault: false,
            fgPalette: true,
            fgColor: 1
          },
          {
            chars: "!",
            fgDefault: false,
            fgPalette: true,
            fgColor: 2
          }
        ]
      ]
    })
  );

  assert.deepEqual(snapshot.lines[0]?.segments, [
    { style: { color: "#cc0000" }, text: "hi" },
    { style: { color: "#4e9a06" }, text: "!" }
  ]);
});

test("terminal surface preview maps bold palette and inverse styles", () => {
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      lines: [
        [
          {
            bold: true,
            chars: "A",
            fgDefault: false,
            fgPalette: true,
            fgColor: 1
          },
          {
            chars: "B",
            fgDefault: false,
            fgPalette: true,
            fgColor: 2,
            bgDefault: false,
            bgPalette: true,
            bgColor: 4,
            inverse: true
          }
        ]
      ]
    })
  );

  assert.deepEqual(snapshot.lines[0]?.segments, [
    { style: { bold: true, color: "#ef2929" }, text: "A" },
    {
      style: {
        background: "#4e9a06",
        color: "#3465a4"
      },
      text: "B"
    }
  ]);
});

test("terminal surface preview maps RGB colors to hex", () => {
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      lines: [
        [
          {
            chars: "R",
            fgDefault: false,
            fgRgb: true,
            fgColor: 0x112233
          },
          {
            chars: "G",
            bgDefault: false,
            bgRgb: true,
            bgColor: 0xaabbcc
          }
        ]
      ]
    })
  );

  assert.deepEqual(snapshot.lines[0]?.segments, [
    { style: { color: "#112233" }, text: "R" },
    { style: { background: "#aabbcc" }, text: "G" }
  ]);
});

test("terminal surface preview handles wide and invisible cells", () => {
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      lines: [
        [
          {
            chars: "中",
            width: 2
          },
          {
            chars: "",
            width: 0
          },
          {
            chars: "x",
            invisible: true,
            width: 1
          },
          {
            chars: "y"
          }
        ]
      ]
    })
  );

  // Wide cells contribute their glyph once; trailing width-0 cells are skipped.
  // Invisible cells become spaces and merge with adjacent default-styled text.
  assert.deepEqual(snapshot.lines[0]?.segments, [{ text: "中 y" }]);
});

test("terminal surface preview trims trailing default-empty cells", () => {
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      cols: 6,
      lines: [
        [
          { chars: "a" },
          { chars: " " },
          { chars: " " },
          { chars: " " },
          { chars: " " },
          { chars: " " }
        ]
      ]
    })
  );

  assert.deepEqual(snapshot.lines[0]?.segments, [{ text: "a" }]);
});

test("terminal surface preview revisions change with content and cursor", () => {
  const base = createTerminalPreviewSnapshot(
    createTerminal({
      cursorX: 0,
      cursorY: 0,
      lines: [[{ chars: "a" }]]
    })
  );
  const contentChanged = createTerminalPreviewSnapshot(
    createTerminal({
      cursorX: 0,
      cursorY: 0,
      lines: [[{ chars: "b" }]]
    })
  );
  const cursorChanged = createTerminalPreviewSnapshot(
    createTerminal({
      cursorX: 1,
      cursorY: 0,
      lines: [[{ chars: "a" }]]
    })
  );

  assert.notEqual(base.revision, contentChanged.revision);
  assert.notEqual(base.revision, cursorChanged.revision);
  assert.match(base.revision, /^8\n1\n0\n0\n0\n/);
});

test("terminal surface preview caps projected rows and columns", () => {
  const lines = Array.from({ length: 30 }, () =>
    Array.from({ length: 200 }, () => ({ chars: "x" as const }))
  );
  const snapshot = createTerminalPreviewSnapshot(
    createTerminal({
      cols: 200,
      rows: 30,
      lines
    })
  );

  assert.equal(snapshot.lines.length, 24);
  assert.equal(
    snapshot.lines[0]?.segments.reduce(
      (total, segment) => total + segment.text.length,
      0
    ),
    160
  );
});
