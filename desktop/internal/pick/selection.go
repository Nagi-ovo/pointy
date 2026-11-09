package pick

import "github.com/pointylab/pointy/desktop/internal/desktop"

// blocked reports whether Pointy keeps out of the foreground window: an
// app it never reads, or a window that looks like a login or password page.
func blocked(d desktop.Desktop, fg desktop.Foreground) bool {
	return d.Blocked(fg.Exe) || desktop.LoginTitle(fg.Title)
}
