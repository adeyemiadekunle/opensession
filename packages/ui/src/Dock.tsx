import { Fragment, useEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactNode, type SetStateAction } from "react";
import { PanelHeader } from "./components/ui/panel";
import { cn } from "./lib/utils";
import { storageGet } from "./hooks";

export type DockPanelId = "files" | "changes" | "git" | "terminal" | "browser";

export interface DockState {
  /** Open panels, top to bottom. */
  stack: DockPanelId[];
  /** Heights the user dragged panels to (only panels with another panel below them). */
  heights: Partial<Record<DockPanelId, number>>;
  /** Width of the whole dock in px. */
  width: number;
}

export const DOCK_TITLES: Record<DockPanelId, string> = {
  files: "Files",
  changes: "Changes",
  git: "Git",
  terminal: "Terminal",
  browser: "Browser",
};

export const DOCK_KEY = "opensession.dock";
const DOCK_MIN = 320;
const DOCK_MAX = 900;
/** Narrowest dock that shows two columns of panels. */
const DOCK_TWO_COLUMNS = 680;
const DOCK_DEFAULT: DockState = { stack: [], heights: {}, width: 468 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Last saved layout, or the default when nothing valid is stored. */
export function loadDock(): DockState {
  try {
    const saved = JSON.parse(storageGet(DOCK_KEY) ?? "null") as Partial<DockState> | null;
    if (!saved || !Array.isArray(saved.stack)) return DOCK_DEFAULT;
    const stack = saved.stack.filter(
      (id, i, all): id is DockPanelId => id in DOCK_TITLES && all.indexOf(id) === i,
    );
    const width = typeof saved.width === "number" ? clamp(saved.width, DOCK_MIN, DOCK_MAX) : DOCK_DEFAULT.width;
    return { stack, heights: saved.heights ?? {}, width };
  } catch {
    return DOCK_DEFAULT;
  }
}

type Drag = { kind: "width"; start: number; size: number } | { kind: "split"; panel: DockPanelId; start: number; size: number };

export interface DockProps {
  state: DockState;
  onChange: Dispatch<SetStateAction<DockState>>;
  onClose: (id: DockPanelId) => void;
  renderBody: (id: DockPanelId) => ReactNode;
  /** Extra buttons in a card's header, before its close button. */
  headerActions?: (id: DockPanelId) => ReactNode;
  /** Cards whose body draws its own header (and close button). */
  ownHeader?: (id: DockPanelId) => boolean;
}

/**
 * Right-hand dock: floating cards stacked with a gap. Dragging the vertical grip changes the
 * dock's width; dragging a gap between two cards changes the height of the card above it.
 */
export function Dock({ state, onChange, onClose, renderBody, headerActions, ownHeader }: DockProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      if (drag.kind === "width") {
        const width = clamp(drag.size - (e.clientX - drag.start), DOCK_MIN, DOCK_MAX);
        onChange((s) => ({ ...s, width }));
      } else {
        const height = Math.max(96, Math.round(drag.size + e.clientY - drag.start));
        onChange((s) => ({ ...s, heights: { ...s.heights, [drag.panel]: height } }));
      }
    };
    const up = () => setDrag(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, onChange]);

  const startWidth = (e: ReactMouseEvent) => {
    e.preventDefault();
    // From the width shown, which two columns can make wider than the saved one.
    const shown = e.currentTarget.parentElement?.getBoundingClientRect().width ?? state.width;
    setDrag({ kind: "width", start: e.clientX, size: Math.round(shown) });
  };

  const startSplit = (upper: DockPanelId, e: ReactMouseEvent) => {
    e.preventDefault();
    const el = stackRef.current?.querySelector<HTMLElement>(`[data-panel="${upper}"]`);
    setDrag({ kind: "split", panel: upper, start: e.clientY, size: el?.getBoundingClientRect().height ?? 200 });
  };

  const { stack, heights } = state;
  // Three or more panels: the first takes a full-height column on the left, the rest stack beside it.
  const columns = stack.length >= 3 ? [stack.slice(0, 1), stack.slice(1)] : [stack];
  const width = columns.length > 1 ? Math.max(state.width, DOCK_TWO_COLUMNS) : state.width;

  const card = (id: DockPanelId, pinned: boolean) => (
    <section
      data-panel={id}
      className={cn(
        "flex min-h-24 flex-col overflow-hidden rounded-lg border border-border bg-sidebar",
        id === "terminal" && "bg-code",
      )}
      style={{ flex: pinned ? `0 0 ${heights[id]}px` : "1 1 0" }}
    >
      {ownHeader?.(id) ? null : (
        <PanelHeader title={DOCK_TITLES[id]} onClose={() => onClose(id)} closeLabel={`Close ${DOCK_TITLES[id]} panel`}>
          {headerActions?.(id)}
        </PanelHeader>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&_.os-terminal]:min-h-0">{renderBody(id)}</div>
    </section>
  );

  const column = (ids: DockPanelId[]) => (
    <div key={ids[0]} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {ids.map((id, i) => {
        const above = ids[i - 1];
        return (
          <Fragment key={id}>
            {above ? (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${DOCK_TITLES[above]} panel height`}
                onMouseDown={(e) => startSplit(above, e)}
                className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center max-[1000px]:hidden"
              >
                <span
                  className={cn(
                    "h-[3px] w-9 rounded-sm bg-input group-hover:bg-primary",
                    drag?.kind === "split" && drag.panel === above && "bg-primary",
                  )}
                />
              </div>
            ) : null}
            {card(id, i < ids.length - 1 && heights[id] !== undefined)}
          </Fragment>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-w-0 shrink-0 max-[1000px]:w-full!" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        onMouseDown={startWidth}
        className="group flex w-2.5 shrink-0 cursor-col-resize items-center justify-center max-[1000px]:hidden"
      >
        <span
          className={cn(
            "h-9 w-[3px] rounded-sm bg-input group-hover:bg-primary",
            drag?.kind === "width" && "bg-primary",
          )}
        />
      </div>
      <div
        ref={stackRef}
        className="flex min-w-0 flex-1 gap-2.5 py-2.5 pr-2.5 max-[1000px]:flex-col max-[1000px]:gap-0 max-[1000px]:px-2.5 max-[1000px]:pb-2.5 max-[1000px]:pt-0"
      >
        {columns.map(column)}
      </div>
    </div>
  );
}
