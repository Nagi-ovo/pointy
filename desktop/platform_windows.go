package main

import (
	"github.com/pointylab/pointy/desktop/internal/desktop"
	win "github.com/pointylab/pointy/desktop/internal/desktop/windows"
)

func newDesktop() desktop.Desktop { return win.New() }
