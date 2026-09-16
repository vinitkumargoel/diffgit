import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTypingTarget, SHORTCUTS, type ShortcutHandlers, useShortcuts } from "./useShortcuts";

afterEach(cleanup);

const press = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document) =>
  fireEvent.keyDown(target, { key, ...init });

describe("useShortcuts", () => {
  it("fires the handler for every documented key without modifiers", () => {
    const handlers: ShortcutHandlers = {};
    for (const s of SHORTCUTS) handlers[s.key] = vi.fn();
    renderHook(() => useShortcuts(handlers));
    for (const s of SHORTCUTS) {
      press(s.key, s.key === "?" ? { shiftKey: true } : {});
      expect(handlers[s.key], s.key).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores ⌘ / Ctrl / Alt combinations, already-handled events and unknown keys", () => {
    const j = vi.fn();
    renderHook(() => useShortcuts({ j }));
    press("j", { metaKey: true });
    press("j", { ctrlKey: true });
    press("j", { altKey: true });
    press("x");
    expect(j).not.toHaveBeenCalled();
    const handled = new KeyboardEvent("keydown", { key: "j", cancelable: true, bubbles: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(j).not.toHaveBeenCalled();
    press("j");
    expect(j).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed into inputs, textareas, selects and contenteditable", () => {
    const slash = vi.fn();
    renderHook(() => useShortcuts({ "/": slash }));
    const { container } = render(
      <>
        <input aria-label="i" />
        <textarea aria-label="t" />
        <select aria-label="s">
          <option>a</option>
        </select>
        <button type="button">b</button>
      </>,
    );
    for (const el of Array.from(container.querySelectorAll("input, textarea, select"))) {
      press("/", {}, el);
      expect(isTypingTarget(el)).toBe(true);
    }
    expect(slash).not.toHaveBeenCalled();
    const button = container.querySelector("button");
    if (!button) throw new Error("no button");
    expect(isTypingTarget(button)).toBe(false);
    press("/", {}, button);
    expect(slash).toHaveBeenCalledTimes(1);
  });

  it("uses the latest handlers without re-subscribing and stops when disabled", () => {
    const first = vi.fn();
    const second = vi.fn();
    const spy = vi.spyOn(document, "addEventListener");
    const { rerender } = renderHook(
      ({ h, on }: { h: ShortcutHandlers; on: boolean }) => useShortcuts(h, on),
      { initialProps: { h: { r: first }, on: true } },
    );
    const subscriptions = spy.mock.calls.filter((c) => c[0] === "keydown").length;
    press("r");
    rerender({ h: { r: second }, on: true });
    press("r");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.filter((c) => c[0] === "keydown").length).toBe(subscriptions);
    rerender({ h: { r: second }, on: false });
    press("r");
    expect(second).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("prevents the default action so `/` never triggers quick-find", () => {
    renderHook(() => useShortcuts({ "/": () => {} }));
    const e = new KeyboardEvent("keydown", { key: "/", cancelable: true, bubbles: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
