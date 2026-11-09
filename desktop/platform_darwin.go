package main

import (
	"path/filepath"

	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/desktop/darwin"
)

func newDesktop(root string) desktop.Desktop {
	return darwin.New(filepath.Join(root, "assets"))
}
