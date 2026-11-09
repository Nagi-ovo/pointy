package desktop

import "context"

// A11y reads other apps' controls through the platform's accessibility
// API: UI Automation on Windows, AX on macOS. Calls give up when ctx ends.
type A11y interface {
	// Grab reads the selection in the focused control.
	Grab(ctx context.Context) (GrabReply, error)
	// PointAt reads the control under p and its ancestors.
	PointAt(ctx context.Context, p Point) (PointReply, error)
	// ElementAt reads the control under p, or its up-th ancestor.
	ElementAt(ctx context.Context, p Point, up int) (ElementReply, error)
}

// The replies keep the shapes and JSON names of the Electron helpers'
// (app/pick/native/uia-selection.ps1 and ax-helper.ts). Control is a UI
// Automation programmatic name such as "ControlType.Document" on every
// platform.

// GrabReply is the focused control's selection.
type GrabReply struct {
	OK         bool   `json:"ok"`
	IsPassword bool   `json:"isPassword,omitzero"`
	Control    string `json:"control,omitzero"`
	Text       string `json:"text,omitzero"`
}

// ChainItem is one control of a PointReply.
type ChainItem struct {
	Rect    *Rect  `json:"rect"`
	Control string `json:"control"`
	Class   string `json:"cls,omitzero"`
	Name    string `json:"name,omitzero"`
}

// PointReply is the control under a point, then its ancestors, at most
// eight. LeafKids and LeafReadable describe the first, Win its window.
type PointReply struct {
	OK           bool        `json:"ok"`
	Chain        []ChainItem `json:"chain"`
	LeafKids     bool        `json:"leafKids,omitzero"`
	LeafReadable bool        `json:"leafReadable,omitzero"`
	Win          *Rect       `json:"win"`
}

// ElementReply is the control the user picked. For a password field it
// carries IsPassword alone.
type ElementReply struct {
	OK         bool   `json:"ok"`
	IsPassword bool   `json:"isPassword,omitzero"`
	Name       string `json:"name,omitzero"`
	Control    string `json:"control,omitzero"`
	ClassName  string `json:"className,omitzero"`
	Rect       *Rect  `json:"rect"`
	Kids       bool   `json:"kids,omitzero"`
	Readable   bool   `json:"readable,omitzero"`
	Win        *Rect  `json:"win"`
	Text       string `json:"text,omitzero"`
	Href       string `json:"href,omitzero"`
}
