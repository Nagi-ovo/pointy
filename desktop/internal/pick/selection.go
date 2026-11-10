package pick

import (
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/i18n"
)

// blockReason says why Pointy keeps out of the foreground window: an app it
// never reads, or a window that looks like a login or password page. It is
// empty when Pointy may read the window.
func blockReason(d desktop.Desktop, fg desktop.Foreground) contract.BlockReason {
	switch {
	case d.Blocked(fg.Exe):
		return contract.BlockApp
	case desktop.LoginTitle(fg.Title):
		return contract.BlockLoginWindow
	}
	return ""
}

// refuse tells the user, in a hint, why nothing opens.
func (p *Picker) refuse(r contract.BlockReason) {
	if hint, ok := i18n.BlockHint(r); ok {
		p.d.ShowHint(hint)
	}
}
