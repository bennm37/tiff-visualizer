"use strict";

/**
 * Keeping the webview focused as the editor group sees it.
 *
 * A viewer's pan and drag handlers call `preventDefault()` on mouse and pointer
 * presses, and in Chromium that also stops the click from moving focus into the
 * webview's frame. Without frame focus VS Code does not learn that the tab was
 * used (the split editor in front stays the other one), and the clipboard
 * refuses to write ("Document is not focused"). Claiming focus in the capture
 * phase, before any handler can cancel the press, restores both.
 */

export function installFocusClaim(target: Window = window): void {
	const claim = () => { if (!target.document.hasFocus()) { target.focus(); } };
	target.addEventListener('mousedown', claim, true);
	target.addEventListener('pointerdown', claim, true);
}

/** Run `action` once the frame has focus, which the clipboard needs; ask for it, and give up waiting after a second. */
export function whenFocused(action: () => void, attempts = 50): void {
	if (document.hasFocus() || attempts <= 0) { action(); return; }
	window.focus();
	setTimeout(() => whenFocused(action, attempts - 1), 20);
}

/** Why a clipboard write failed, in words that say what to do when the cause is missing focus. */
export function clipboardFailure(error: unknown, what: string): string {
	const text = error instanceof Error ? error.message : String(error);
	return /focus/i.test(text) ? `Failed to copy ${what}: click the viewer first, then copy again.` : `Failed to copy ${what}: ${text}`;
}
