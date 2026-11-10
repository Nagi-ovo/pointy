//go:build darwin

package darwin

import (
	"testing"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func TestOwnerOffScreenStaysUntilItIsGone(t *testing.T) {
	reads := 0
	l := ownerLookup{
		onScreen: map[desktop.WindowID]int{1: 0},
		listAll: func() []cgWindow {
			reads++
			return []cgWindow{{id: 1}, {id: 2}}
		},
	}
	if !l.exists(1) {
		t.Fatal("an on-screen owner was dropped")
	}
	if reads != 0 {
		t.Fatal("read the full window list for an on-screen owner")
	}
	if !l.exists(2) {
		t.Fatal("a minimized or other-Space owner was dropped")
	}
	if l.exists(3) {
		t.Fatal("a closed owner was kept")
	}
	if reads != 1 {
		t.Fatalf("read the full window list %d times in one pass, want 1", reads)
	}
}
