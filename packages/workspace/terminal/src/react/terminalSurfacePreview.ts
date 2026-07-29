import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import type {
  TerminalPreviewLine,
  TerminalPreviewSegment,
  TerminalPreviewSegmentStyle,
  TerminalPreviewSnapshot,
  TerminalTheme
} from "../contracts/index.ts";

const terminalPreviewMaxRows = 24;
const terminalPreviewMaxCols = 160;
const terminalPreviewAnsiColors = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec"
] as const;
const terminalPreviewColorSteps = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

export function createTerminalPreviewSnapshot(
  terminal: Terminal
): TerminalPreviewSnapshot {
  const buffer = terminal.buffer.active;
  const rowCount = Math.min(terminal.rows, terminalPreviewMaxRows);
  const colCount = Math.min(terminal.cols, terminalPreviewMaxCols);
  const viewportY = Math.max(0, buffer.viewportY);
  const theme = terminal.options.theme as TerminalTheme;
  const lines: TerminalPreviewLine[] = [];
  const scratchCell = buffer.getNullCell();

  for (let index = 0; index < rowCount; index += 1) {
    lines.push(
      createTerminalPreviewLine({
        colCount,
        line: buffer.getLine(viewportY + index) ?? null,
        scratchCell,
        theme
      })
    );
  }

  const revision = [
    terminal.cols,
    terminal.rows,
    buffer.cursorX,
    buffer.cursorY,
    viewportY,
    JSON.stringify(lines)
  ].join("\n");

  return {
    cols: terminal.cols,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
    revision,
    rows: terminal.rows,
    updatedAtUnixMs: Date.now()
  };
}

function createTerminalPreviewLine(input: {
  colCount: number;
  line: IBufferLine | null;
  scratchCell: IBufferCell;
  theme: TerminalTheme;
}): TerminalPreviewLine {
  const line = input.line;
  if (!line || input.colCount <= 0) {
    return { segments: [] };
  }

  const segments: TerminalPreviewSegment[] = [];
  let currentStyle: TerminalPreviewSegmentStyle | undefined;
  let currentText = "";
  const lastColumn = resolveTerminalPreviewLastColumn({
    colCount: input.colCount,
    line,
    scratchCell: input.scratchCell,
    theme: input.theme
  });

  for (let column = 0; column < lastColumn; column += 1) {
    const cell = line.getCell(column, input.scratchCell);
    if (!cell) {
      continue;
    }
    const width = cell.getWidth();
    if (width === 0) {
      continue;
    }
    const style = resolveTerminalPreviewCellStyle(cell, input.theme);
    const text = cell.isInvisible()
      ? " ".repeat(Math.max(1, width))
      : cell.getChars() || " ".repeat(Math.max(1, width));

    if (currentText && areTerminalPreviewStylesEqual(currentStyle, style)) {
      currentText += text;
      continue;
    }
    if (currentText) {
      segments.push(createTerminalPreviewSegment(currentText, currentStyle));
    }
    currentStyle = style;
    currentText = text;
  }

  if (currentText) {
    segments.push(createTerminalPreviewSegment(currentText, currentStyle));
  }

  return { segments };
}

function createTerminalPreviewSegment(
  text: string,
  style: TerminalPreviewSegmentStyle | undefined
): TerminalPreviewSegment {
  if (!style) {
    return { text };
  }
  return { style, text };
}

function resolveTerminalPreviewLastColumn(input: {
  colCount: number;
  line: IBufferLine;
  scratchCell: IBufferCell;
  theme: TerminalTheme;
}) {
  for (let column = input.colCount - 1; column >= 0; column -= 1) {
    const cell = input.line.getCell(column, input.scratchCell);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }
    if (!isTerminalPreviewCellEmptyDefault(cell, input.theme)) {
      return column + 1;
    }
  }
  return 0;
}

function isTerminalPreviewCellEmptyDefault(
  cell: IBufferCell,
  theme: TerminalTheme
) {
  const style = resolveTerminalPreviewCellStyle(cell, theme);
  return (cell.getChars() || " ") === " " && !style;
}

function resolveTerminalPreviewCellStyle(
  cell: IBufferCell,
  theme: TerminalTheme
): TerminalPreviewSegmentStyle | undefined {
  const style: TerminalPreviewSegmentStyle = {};
  const inverse = Boolean(cell.isInverse());
  const foreground = resolveTerminalPreviewColor(cell, "foreground", theme);
  const background = resolveTerminalPreviewColor(cell, "background", theme);
  const color = inverse ? (background ?? theme.background) : foreground;
  const backgroundColor = inverse
    ? (foreground ?? theme.foreground)
    : background;

  if (color) {
    style.color = color;
  }
  if (backgroundColor) {
    style.background = backgroundColor;
  }
  if (cell.isBold()) {
    style.bold = true;
  }
  if (cell.isDim()) {
    style.dim = true;
  }
  if (cell.isItalic()) {
    style.italic = true;
  }
  if (cell.isUnderline()) {
    style.underline = true;
  }
  if (cell.isStrikethrough()) {
    style.strikethrough = true;
  }
  if (cell.isOverline()) {
    style.overline = true;
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

function resolveTerminalPreviewColor(
  cell: IBufferCell,
  channel: "background" | "foreground",
  theme: TerminalTheme
) {
  const isDefault =
    channel === "foreground" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return undefined;
  }
  const isRgb = channel === "foreground" ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette =
    channel === "foreground" ? cell.isFgPalette() : cell.isBgPalette();
  const rawColor =
    channel === "foreground" ? cell.getFgColor() : cell.getBgColor();

  if (isRgb) {
    return terminalPreviewColorToHex(rawColor);
  }
  if (!isPalette) {
    return undefined;
  }

  const paletteIndex =
    channel === "foreground" && cell.isBold() && rawColor >= 0 && rawColor <= 7
      ? rawColor + 8
      : rawColor;
  const paletteColor = resolveTerminalPreviewPaletteColor(paletteIndex);
  if (paletteColor) {
    return paletteColor;
  }
  return channel === "foreground" ? theme.foreground : theme.background;
}

function resolveTerminalPreviewPaletteColor(index: number) {
  if (index >= 0 && index < terminalPreviewAnsiColors.length) {
    return terminalPreviewAnsiColors[index];
  }
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const red = terminalPreviewColorSteps[Math.floor(offset / 36) % 6] ?? 0;
    const green = terminalPreviewColorSteps[Math.floor(offset / 6) % 6] ?? 0;
    const blue = terminalPreviewColorSteps[offset % 6] ?? 0;
    return terminalPreviewRgbToHex(red, green, blue);
  }
  if (index >= 232 && index <= 255) {
    const value = 8 + (index - 232) * 10;
    return terminalPreviewRgbToHex(value, value, value);
  }
  return undefined;
}

function terminalPreviewColorToHex(color: number) {
  return `#${color.toString(16).padStart(6, "0").slice(-6)}`;
}

function terminalPreviewRgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function areTerminalPreviewStylesEqual(
  left: TerminalPreviewSegmentStyle | undefined,
  right: TerminalPreviewSegmentStyle | undefined
) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.background === right.background &&
    left.bold === right.bold &&
    left.color === right.color &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.overline === right.overline &&
    left.strikethrough === right.strikethrough &&
    left.underline === right.underline
  );
}
