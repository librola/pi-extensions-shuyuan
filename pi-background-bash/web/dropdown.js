import { readBackgroundCount } from "./counter.js";

/** @param {typeof import('react')} React @param {import('react').ComponentType<{ context: import('./api.d.ts').ViewContext }>} Tasks */
export function createDropdown(React, Tasks) {
  const h = React.createElement;
  /** @type {((context: import('./api.d.ts').ViewContext) => boolean) | undefined} */
  let opener;

  /** @param {{ context: import('./api.d.ts').ViewContext }} props */
  function Dropdown({ context }) {
    const latest = React.useRef(context);
    latest.current = context;
    const anchor = React.useRef(/** @type {HTMLButtonElement | null} */ (null));
    const popup = React.useRef(/** @type {HTMLDialogElement | null} */ (null));
    const root = React.useRef(/** @type {HTMLDivElement | null} */ (null));
    const [open, setOpen] = React.useState(false);
    const [snapshot, setSnapshot] = React.useState(/** @type {{ value: number; owner: string; cwd: string | null; signal: AbortSignal } | null} */ (null));
    const count = !context.signal.aborted && snapshot?.owner === context.sessionId && snapshot?.cwd === context.cwd && snapshot?.signal === context.signal ? snapshot.value : null;
    const [position, setPosition] = React.useState({ left: 8, top: 40, width: 640, maxHeight: 600 });
    const popupId = "pbb-dropdown-" + React.useId();
    const close = () => { setOpen(false); anchor.current?.focus(); };

    React.useEffect(() => {
      const show = /** @param {import('./api.d.ts').ViewContext} requested */ requested => {
        const current = latest.current;
        if (requested.signal.aborted || current.signal.aborted || requested.sessionId !== current.sessionId || requested.cwd !== current.cwd) return false;
        setOpen(true);
        return true;
      };
      opener = show;
      return () => { if (opener === show) opener = undefined; };
    }, []);
    React.useEffect(() => { setOpen(false); }, [context.sessionId, context.cwd]);

    // 收起时也刷新数量，详细状态/输出仍由用户操作；仅一条在途查询，失效结果不跨视图写回。
    React.useEffect(() => {
      const owner = context.sessionId, cwd = context.cwd, signal = context.signal;
      setSnapshot(null);
      if (!owner) return;
      let owned = true, reading = false;
      const current = () => owned && !signal.aborted && latest.current.sessionId === owner && latest.current.cwd === cwd && latest.current.signal === signal;
      const read = async () => {
        if (reading || document.hidden || !current()) return;
        reading = true;
        try {
          const value = await readBackgroundCount(latest.current);
          if (current()) setSnapshot(old => value === null ? null : old?.value === value && old.owner === owner && old.cwd === cwd && old.signal === signal ? old : { value, owner, cwd, signal });
        } catch {
          if (current()) setSnapshot(null);
        } finally { reading = false; }
      };
      void read();
      const timer = setInterval(() => { void read(); }, 2000);
      const visible = () => { if (!document.hidden) void read(); };
      document.addEventListener("visibilitychange", visible);
      return () => { owned = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
    }, [context.sessionId, context.cwd, context.signal]);

    React.useLayoutEffect(() => {
      if (!open) return;
      const node = popup.current;
      if (!node) return;
      const popover = typeof node.showPopover === "function";
      // 顶层展示避开移动工具栏的 transform/overflow；旧 Safari 使用原生 dialog 回退。
      if (popover) { node.setAttribute("popover", "manual"); node.showPopover(); }
      else if (typeof node.showModal === "function") node.showModal();
      const place = () => {
        const box = anchor.current?.getBoundingClientRect();
        const width = Math.min(640, window.innerWidth - 16);
        const top = box && box.height ? box.bottom + 6 : 42;
        const left = Math.max(8, Math.min(box?.left ?? 8, window.innerWidth - width - 8));
        const maxHeight = Math.max(0, Math.min(650, window.innerHeight - top - 8));
        setPosition(old => old.left === left && old.top === top && old.width === width && old.maxHeight === maxHeight ? old : { left, top, width, maxHeight });
      };
      place();
      const focus = requestAnimationFrame(() => popup.current?.querySelector("button")?.focus());
      const outside = /** @param {PointerEvent} event */ event => {
        const box = node.getBoundingClientRect();
        const backdrop = event.target === node && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
        if (backdrop || (event.target instanceof Node && !root.current?.contains(event.target))) setOpen(false);
      };
      const escape = /** @param {KeyboardEvent} event */ event => {
        if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
        // 捕获 Escape 只收起下拉框，不能误触主 agent 的停止快捷键。
        event.preventDefault(); event.stopPropagation(); close();
      };
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", escape, true);
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(focus);
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", escape, true);
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
        if (popover && node.matches(":popover-open")) node.hidePopover();
        else if (node.open) node.close();
      };
    }, [open]);

    return h("div", { className: "pbb-toolbar-dropdown", ref: root },
      h("button", { type: "button", className: "pbb-toolbar", ref: anchor,
        "aria-haspopup": "dialog", "aria-expanded": open, "aria-controls": popupId, "aria-label": "后台任务", "aria-describedby": popupId + "-count",
        title: count === null ? "后台任务（运行数量未确认）" : `${count} 个后台任务正在运行`,
        onClick: () => setOpen(value => !value) },
        h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true },
          h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h("path", { d: "m7 9 3 3-3 3m6 0h4" })),
        "后台任务", count === null ? null : h("span", { className: "pbb-count", "data-running": count, "aria-hidden": true }, count),
        h("span", { className: "pbb-chevron", "aria-hidden": true }, open ? "▴" : "▾")),
      h("span", { id: popupId + "-count", className: "pbb-count-description", role: "status", "aria-live": "polite", "aria-atomic": true }, count === null ? "运行数量未确认" : `${count} 个后台任务正在运行`),
      open ? h("dialog", { id: popupId, className: "pbb-dropdown", "data-pbb": "dropdown", role: "dialog", "aria-label": "后台 Bash 任务", ref: popup, style: position },
        h("div", { className: "pbb-dropdown-heading" }, h("strong", null, "后台 Bash 任务"),
          h("button", { type: "button", className: "pbb-close", "aria-label": "收起后台任务", onClick: close }, "×")),
        h(Tasks, { context })) : null);
  }

  return {
    component: Dropdown,
    /** @param {import('./api.d.ts').ViewContext} context */
    open: context => opener?.(context) ?? false,
  };
}
