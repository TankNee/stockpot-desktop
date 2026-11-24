import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWindows } from "@/lib/platform";

/** The edge or corner a resize drag starts from. Tauri declares this union but
 *  does not re-export it, so the literal set is mirrored here. */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/** True when the page is running inside the Tauri webview rather than a plain
 *  browser tab. Both `pnpm dev` previews and unit tests take the false path. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Windows convention (Fluent / WinUI): square caption buttons pinned to the
 *  top-right corner, 46×32 px hit areas at 100 % scale, glyphs 10×10 with a
 *  hairline stroke, a light wash on hover and the red `#C42B1C` treatment for
 *  close. Keeping the metrics exact is what makes a hand-drawn title bar feel
 *  native instead of merely "custom". */

const GLYPH = 10;

function MinimizeGlyph() {
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 10 10" aria-hidden focusable="false">
      <path d="M0 5.5h10" stroke="currentColor" strokeWidth={1} shapeRendering="crispEdges" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 10 10" aria-hidden focusable="false">
      <rect
        x={0.5}
        y={0.5}
        width={9}
        height={9}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

function RestoreGlyph() {
  // Two overlapping squares, the way Windows draws "restore down".
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 10 10" aria-hidden focusable="false">
      <path
        d="M2.5 2.5V0.5h7v7h-2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
      <rect
        x={0.5}
        y={2.5}
        width={7}
        height={7}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 10 10" aria-hidden focusable="false">
      <path
        d="M0.5 0.5l9 9M9.5 0.5l-9 9"
        stroke="currentColor"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

type CaptionButtonProps = {
  label: string;
  onClick: () => void;
  close?: boolean;
  children: React.ReactNode;
};

function CaptionButton({ label, onClick, close, children }: CaptionButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={close ? "caption-btn is-close" : "caption-btn"}
      // The caption area must never start a window drag.
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </button>
  );
}

export type CaptionButtonsProps = {
  /** Hide the panel / close the window through the backend command so the
   *  window keeps its state (the ledger and settings windows are hidden, not
   *  destroyed, on close). */
  onClose: () => void;
  /** Windows only; macOS keeps its native traffic lights. */
  resizable?: boolean;
};

/** Draw-minimise / maximise / close buttons for a frameless Windows window. */
export function CaptionButtons({ onClose, resizable = true }: CaptionButtonsProps) {
  const [maximized, setMaximized] = React.useState(false);
  const [canResize, setCanResize] = React.useState(resizable);

  React.useEffect(() => {
    if (!isWindows() || !inTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let alive = true;
    void win.isMaximized().then((value) => alive && setMaximized(value)).catch(() => {});
    void win.isResizable().then((value) => alive && setCanResize(value && resizable)).catch(() => {});
    void win
      .onResized(() => {
        void win.isMaximized().then((value) => alive && setMaximized(value)).catch(() => {});
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [resizable]);

  if (!isWindows()) return null;

  const minimize = () => {
    if (!inTauri()) return;
    void getCurrentWindow().minimize();
  };
  const toggleMaximize = () => {
    if (!inTauri()) return;
    void getCurrentWindow().toggleMaximize();
  };

  return (
    <div className="caption-buttons" role="group" aria-label="Window controls">
      <CaptionButton label="最小化" onClick={minimize}>
        <MinimizeGlyph />
      </CaptionButton>
      {canResize ? (
        <CaptionButton label={maximized ? "向下还原" : "最大化"} onClick={toggleMaximize}>
          {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </CaptionButton>
      ) : null}
      <CaptionButton label="关闭" onClick={onClose} close>
        <CloseGlyph />
      </CaptionButton>
    </div>
  );
}

/** Double-clicking a drag region maximises the window, exactly like the system
 *  title bar. Only fires when the click started on a drag region, so double
 *  clicks on buttons or rows stay with the content. */
export function handleTitleBarDoubleClick(event: React.MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest("[data-tauri-drag-region]")) return;
  if (!inTauri() || !isWindows()) return;
  void getCurrentWindow().toggleMaximize();
}

const RESIZE_HANDLES: Array<{
  direction: ResizeDirection;
  style: React.CSSProperties;
}> = [
  { direction: "North", style: { top: 0, left: 0, right: 0, height: 4, cursor: "ns-resize" } },
  { direction: "South", style: { bottom: 0, left: 0, right: 0, height: 4, cursor: "ns-resize" } },
  { direction: "West", style: { top: 0, bottom: 0, left: 0, width: 4, cursor: "ew-resize" } },
  { direction: "East", style: { top: 0, bottom: 0, right: 0, width: 4, cursor: "ew-resize" } },
  { direction: "NorthWest", style: { top: 0, left: 0, width: 12, height: 12, cursor: "nwse-resize" } },
  { direction: "NorthEast", style: { top: 0, right: 0, width: 12, height: 12, cursor: "nesw-resize" } },
  { direction: "SouthWest", style: { bottom: 0, left: 0, width: 12, height: 12, cursor: "nesw-resize" } },
  { direction: "SouthEast", style: { bottom: 0, right: 0, width: 12, height: 12, cursor: "nwse-resize" } },
];

/** A frameless window has no native resize border, so the edges are recreated
 *  as invisible strips that hand the drag back to the OS. */
export function ResizeHandles() {
  if (!isWindows()) return null;
  return (
    <>
      {RESIZE_HANDLES.map(({ direction, style }) => (
        <div
          key={direction}
          aria-hidden
          style={{ position: "absolute", zIndex: 60, ...style }}
          onMouseDown={(event) => {
            event.preventDefault();
            if (!inTauri()) return;
            void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
    </>
  );
}
