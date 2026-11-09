package main

import (
	"path/filepath"

	"github.com/pointylab/pointy/desktop/internal/desktop"
	win "github.com/pointylab/pointy/desktop/internal/desktop/windows"
)

func newDesktop(root string) desktop.Desktop {
	return win.New(filepath.Join(root, "assets", "cursor"))
}
